import { BaseTask, type TaskResult } from './base-task.js';
import type {
  LLMProvider,
  LLMMessage,
  LLMToolDefinition,
  LLMToolHandler,
  LLMCompletionResponse,
} from './llm-provider.js';
import {
  runCompletion,
  pickRunOptions,
  coerceStructured,
  StructuredOutputError,
  type AgentRunFields,
  type AgentRetryOptions,
} from './llm-runner.js';
import { validateJson, formatErrors } from './json-schema.js';
import { preview, truncate } from './redact.js';
import { mapLimit } from './concurrency.js';
import {
  createLedger,
  chargeLedger,
  ledgerExhausted,
  exhaustedLimit,
  type TokenLedger,
} from './token-ledger.js';

/**
 * A tool the agent may call. Backed by an existing flowkit primitive — a
 * `task`, a `flow`, or another `agent` — or by a context handler. Exactly one
 * backing is used, resolved in that order; `flow`/`agent` require a FlowRunner
 * context.
 */
export interface AgentToolSpec {
  /**
   * Name exposed to the model. Defaults to the referenced task/flow/agent.
   * Required when the tool is backed by a context handler (`ctx.agentTools`).
   */
  name?: string;
  /** Flowkit task to invoke when the model calls this tool. */
  task?: string;
  /** Flowkit flow to run when the model calls this tool. */
  flow?: string;
  /** Another agent to invoke (sub-agent) when the model calls this tool. */
  agent?: string;
  /** Human/model-readable description of what the tool does. */
  description?: string;
  /**
   * JSON Schema for the tool's arguments. Describes the tool to the model and
   * is enforced before the tool runs — invalid arguments are rejected and fed
   * back to the model rather than executed.
   */
  parameters?: Record<string, unknown>;
}

export interface AgentTaskOptions extends AgentRunFields, AgentRetryOptions {
  /** Initial user prompt / task for the agent. Required. */
  prompt: string;
  /** System prompt / instructions. */
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Tools the agent is allowed to call. Acts as an allowlist. */
  tools?: AgentToolSpec[];
  /** Max model turns before the agent gives up. Default 8. */
  maxIterations?: number;
  /**
   * Aggregate token budget across the whole loop (input + output, summed over
   * every turn and sub-agent). The loop stops and the step fails once it is
   * reached. Default 0 (unbounded). Strongly recommended for any agent with
   * tools — a tool loop with no token cap is unbounded spend.
   */
  tokenBudget?: number;
  /** Max tool calls executed concurrently within a single turn. Default 4. */
  maxConcurrency?: number;
  /** Cap on a single tool result's serialized size, in chars. Default 8000. */
  maxToolResultChars?: number;
  /**
   * Cap on a sub-agent (`agent:` tool) result's serialized size, in chars.
   * Separate from `maxToolResultChars` because a sub-agent's answer often
   * carries code, diffs, or stack traces that an 8000-char opaque-tool cap would
   * clip mid-payload. Default 0 (unbounded — rely on the sub-agent's own budget
   * and output caps).
   */
  maxAgentResultChars?: number;
  /** Max depth of agent-calls-agent recursion. Default 6. */
  maxAgentDepth?: number;
  /**
   * JSON Schema for the final answer. When set, once the agent stops calling
   * tools its answer is rendered and validated as schema-conforming JSON
   * (with repair). A persistent mismatch fails the task.
   */
  schema?: Record<string, unknown>;
}

interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** Truncated result/error string fed back to the model. */
  result: string;
}

/**
 * Agentic, multi-turn LLM task with tool calling.
 *
 * The model is given a set of tools (each backed by a flowkit task or a host
 * `ctx.agentTools` handler) and loops: it requests tool calls, the agent runs
 * them, feeds the results back, and repeats until the model produces a final
 * answer or `maxIterations` is reached.
 *
 * Tools form a strict allowlist — only declared tools are callable, and the
 * model's arguments are validated against each tool's `parameters` schema
 * before the tool runs. The provider must be on the context as `ctx.llm`.
 *
 * Output shape (`result.data`):
 *   - `text`         — the final answer text
 *   - `parsed`       — final structured value when `schema` was provided
 *   - `iterations`   — number of model turns taken
 *   - `toolCalls`    — record of every tool call (name, args, ok, result)
 *   - `usage`        — aggregated token usage across all turns, if reported
 *   - `finishReason` — final stop reason
 */
export class AgentTask extends BaseTask<AgentTaskOptions> {
  get taskName() {
    return 'agent';
  }

  protected validate(): void {
    if (!this.options?.prompt || typeof this.options.prompt !== 'string') {
      throw new Error('agent requires a `prompt` string option');
    }
    let hasAgentTool = false;
    for (const spec of this.options.tools ?? []) {
      if (!spec.task && !spec.flow && !spec.agent && !spec.name) {
        throw new Error('agent tool must reference a `task`, `flow`, or `agent`, or declare a `name`');
      }
      if (spec.agent) hasAgentTool = true;
    }
    // Sub-agent fan-out is the multiplicative-spend case. Require a budget for
    // it unless an enclosing agent already established one (shared ledger).
    if (
      hasAgentTool &&
      !((this.options.tokenBudget ?? 0) > 0) &&
      !this.ctx.__tokenLedger
    ) {
      throw new Error(
        'agent with `agent:` tools must set a `tokenBudget` (or run under one) — ' +
          'sub-agent fan-out is unbounded otherwise',
      );
    }
  }

  async execute(): Promise<TaskResult> {
    const provider = this.ctx.llm as LLMProvider | undefined;
    if (!provider || typeof provider.complete !== 'function') {
      return {
        success: false,
        error: new Error('agent: no LLM provider configured. Attach one to ctx.llm before running.'),
      };
    }

    const {
      prompt,
      system,
      model,
      maxTokens,
      temperature,
      tools = [],
      maxIterations = 8,
      tokenBudget = 0,
      maxConcurrency = 4,
      schema,
    } = this.options;

    const runOpts = pickRunOptions(this.options);
    const specsByName = new Map<string, AgentToolSpec>();
    const toolDefs: LLMToolDefinition[] = [];
    for (const spec of tools) {
      const name = (spec.name ?? spec.task ?? spec.flow ?? spec.agent)!;
      specsByName.set(name, spec);
      toolDefs.push({
        name,
        description: spec.description,
        parameters: spec.parameters ?? { type: 'object', properties: {} },
      });
    }

    // Budget ledger: adopt the enclosing agent's ledger (so this whole subtree
    // counts against one ceiling), and open a tighter nested frame if this agent
    // sets its own tokenBudget. Charges roll up through every frame.
    const inheritedLedger = this.ctx.__tokenLedger;
    const ledger: TokenLedger | undefined =
      tokenBudget > 0 ? createLedger(tokenBudget, inheritedLedger) : inheritedLedger;

    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
    const toolCallLog: ToolCallRecord[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | undefined;

    const charge = (resp: LLMCompletionResponse) =>
      chargeLedger(ledger, (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0));

    this.logger.debug(
      { model, tools: toolDefs.map((t) => t.name), prompt: preview(prompt) },
      'agent: starting loop',
    );

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        const hitLimit = exhaustedLimit(ledger);
        if (hitLimit !== undefined) {
          return {
            success: false,
            error: new Error(`agent exceeded token budget (${hitLimit})`),
            data: { iterations: iteration - 1, toolCalls: toolCallLog, usage, finishReason },
          };
        }

        const response = await runCompletion(
          provider,
          {
            system,
            messages,
            model,
            maxTokens,
            temperature,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
            signal: this.ctx.signal,
          },
          runOpts,
          this.logger,
        );
        accumulateUsage(usage, response);
        charge(response);
        finishReason = response.finishReason;

        const calls = response.toolCalls ?? [];
        if (calls.length === 0) {
          // Final answer. Apply structured output if a schema was requested.
          const data: Record<string, unknown> = {
            text: response.text,
            iterations: iteration,
            toolCalls: toolCallLog,
            finishReason,
          };
          if (usage.inputTokens || usage.outputTokens) data.usage = usage;

          if (schema) {
            // If the final answer already conforms, take it as-is; only spend a
            // round-trip on the structured pass when it doesn't.
            const direct = coerceStructured(response, schema);
            if (!direct.errors) {
              data.parsed = direct.parsed;
            } else {
              const structured = await this.finalizeStructured(
                provider,
                messages,
                response,
                schema,
                runOpts,
              );
              accumulateUsage(usage, structured);
              charge(structured);
              data.text = structured.text;
              data.parsed = structured.parsed;
              if (usage.inputTokens || usage.outputTokens) data.usage = usage;
            }
          }

          return { success: true, data };
        }

        // Record the assistant's tool-call turn, then run the calls. Multiple
        // calls in one turn (e.g. parallel sub-agents) run concurrently under
        // maxConcurrency; results are reassembled in call order so the
        // conversation the model sees is deterministic.
        messages.push({ role: 'assistant', content: response.text, toolCalls: calls });
        const records = await mapLimit(calls, maxConcurrency, (call) =>
          this.runTool(specsByName, call.name, call.arguments, ledger),
        );
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const record = records[i]!;
          toolCallLog.push(record);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: record.result,
          });
        }
      }

      // Loop fell through — the model kept asking for tools.
      return {
        success: false,
        error: new Error(`agent exceeded maxIterations (${maxIterations}) without a final answer`),
        data: { iterations: maxIterations, toolCalls: toolCallLog, usage, finishReason },
      };
    } catch (err) {
      if (err instanceof StructuredOutputError) {
        return {
          success: false,
          error: err,
          data: { text: err.rawText, validationErrors: err.validationErrors, toolCalls: toolCallLog },
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { toolCalls: toolCallLog },
      };
    }
  }

  /**
   * Dispatch one tool call. Enforces the allowlist and the argument schema
   * before executing; any rejection becomes a result string fed back to the
   * model so it can correct itself rather than aborting the run.
   */
  private async runTool(
    specsByName: Map<string, AgentToolSpec>,
    name: string,
    args: Record<string, unknown>,
    ledger: TokenLedger | undefined,
  ): Promise<ToolCallRecord> {
    const fail = (result: string): ToolCallRecord => ({ name, arguments: args, ok: false, result });

    const spec = specsByName.get(name);
    if (!spec) {
      return fail(`Error: unknown tool "${name}". It is not in the allowed tool list.`);
    }

    // Sub-agent answers get their own (default-unbounded) cap so code/diffs are
    // not clipped like opaque tool output.
    const cap = spec.agent
      ? this.options.maxAgentResultChars ?? Number.POSITIVE_INFINITY
      : this.options.maxToolResultChars ?? 8000;

    if (spec.parameters) {
      const check = validateJson(args, spec.parameters);
      if (!check.valid) {
        return fail(`Error: invalid arguments — ${formatErrors(check.errors)}`);
      }
    }

    this.logger.debug({ tool: name, args }, 'agent: invoking tool');

    try {
      let result: TaskResult;
      if (spec.task) {
        result = await this.call(spec.task, args);
      } else if (spec.flow) {
        if (!this.ctx.runFlow) {
          return fail(`Error: flow tools require a FlowRunner context (ctx.runFlow missing).`);
        }
        result = await this.ctx.runFlow(spec.flow, args);
      } else if (spec.agent) {
        if (!this.ctx.runAgent) {
          return fail(`Error: agent tools require a FlowRunner context (ctx.runAgent missing).`);
        }
        const myDepth = this.ctx.__agentDepth ?? 0;
        const maxDepth = this.options.maxAgentDepth ?? 6;
        if (myDepth >= maxDepth) {
          return fail(`Error: max agent depth (${maxDepth}) reached; refusing to nest deeper.`);
        }
        // Pass our ledger down so the sub-agent's spend charges this budget too.
        result = await this.ctx.runAgent(spec.agent, args, myDepth + 1, ledger);
      } else {
        const handler = this.ctx.agentTools?.[name] as LLMToolHandler | undefined;
        if (typeof handler !== 'function') {
          return fail(`Error: tool "${name}" has no task/flow/agent and no ctx.agentTools handler.`);
        }
        return { name, arguments: args, ok: true, result: truncate(serializeToolResult(await handler(args)), cap) };
      }

      if (!result.success) {
        return fail(`Error: ${result.error?.message ?? 'tool invocation failed'}`);
      }
      return { name, arguments: args, ok: true, result: truncate(serializeToolResult(result.data ?? {}), cap) };
    } catch (err) {
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Render the agent's final answer as schema-conforming JSON. Delegates to the
   * runner so validation + repair behave exactly as in the single-shot task.
   */
  private async finalizeStructured(
    provider: LLMProvider,
    messages: LLMMessage[],
    last: LLMCompletionResponse,
    schema: Record<string, unknown>,
    runOpts: ReturnType<typeof pickRunOptions>,
  ) {
    return runCompletion(
      provider,
      {
        system: this.options.system,
        messages: [
          ...messages,
          { role: 'assistant', content: last.text },
          {
            role: 'user',
            content: 'Return your final answer as JSON conforming to the required schema.',
          },
        ],
        model: this.options.model,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
        schema,
        signal: this.ctx.signal,
      },
      runOpts,
      this.logger,
    );
  }
}

function serializeToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function accumulateUsage(
  acc: { inputTokens: number; outputTokens: number },
  resp: LLMCompletionResponse,
): void {
  acc.inputTokens += resp.usage?.inputTokens ?? 0;
  acc.outputTokens += resp.usage?.outputTokens ?? 0;
}
