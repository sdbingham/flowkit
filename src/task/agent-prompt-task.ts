import { BaseTask, type TaskResult } from './base-task.js';
import type { LLMProvider } from './llm-provider.js';
import {
  runCompletion,
  pickRunOptions,
  StructuredOutputError,
  type AgentRunFields,
  type AgentRetryOptions,
} from './llm-runner.js';
import { preview } from './redact.js';

export interface AgentPromptOptions extends AgentRunFields, AgentRetryOptions {
  /** User prompt. Required. */
  prompt: string;
  /** System prompt / instructions. */
  system?: string;
  /** Model identifier — provider-specific. */
  model?: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /**
   * JSON Schema for structured output. When set, the response is validated and,
   * on a mismatch, the model is re-prompted with the errors (see `repairAttempts`).
   * A persistent mismatch fails the task.
   */
  schema?: Record<string, unknown>;
}

/**
 * Single-shot LLM call. The dumb primitive: one prompt in, one response out,
 * hardened by `runCompletion` (timeout, retry/backoff, structured-output
 * validation + repair, output cap). For tool-calling / multi-turn agents use
 * `AgentTask`.
 *
 * The provider must be on the task context as `ctx.llm`.
 *
 * Output shape (`result.data`):
 *   - `text`         — raw model output (always)
 *   - `parsed`       — structured value when `schema` was provided
 *   - `usage`        — token usage if reported
 *   - `finishReason` — why the model stopped, if reported
 *   - `model`        — the model that served the request, if reported
 *   - `truncated`    — true when `maxOutputChars` clipped the text
 */
export class AgentPromptTask extends BaseTask<AgentPromptOptions> {
  get taskName() {
    return 'agent_prompt';
  }

  protected validate(): void {
    if (!this.options?.prompt || typeof this.options.prompt !== 'string') {
      throw new Error('agent_prompt requires a `prompt` string option');
    }
  }

  async execute(): Promise<TaskResult> {
    const provider = this.ctx.llm as LLMProvider | undefined;
    if (!provider || typeof provider.complete !== 'function') {
      return {
        success: false,
        error: new Error(
          'agent_prompt: no LLM provider configured. Attach one to ctx.llm before running.',
        ),
      };
    }

    this.logger.debug(
      { model: this.options.model, prompt: preview(this.options.prompt) },
      'agent_prompt: calling LLM',
    );

    try {
      const response = await runCompletion(
        provider,
        {
          prompt: this.options.prompt,
          system: this.options.system,
          model: this.options.model,
          maxTokens: this.options.maxTokens,
          temperature: this.options.temperature,
          schema: this.options.schema,
        },
        pickRunOptions(this.options),
        this.logger,
      );

      const data: Record<string, unknown> = { text: response.text };
      if (response.parsed !== undefined) data.parsed = response.parsed;
      if (response.usage) data.usage = response.usage;
      if (response.finishReason) data.finishReason = response.finishReason;
      if (response.model) data.model = response.model;
      if (response.truncated) data.truncated = true;

      return { success: true, data };
    } catch (err) {
      // Surface the raw text alongside the failure so callers can debug a
      // model that wouldn't conform to the schema.
      if (err instanceof StructuredOutputError) {
        return {
          success: false,
          error: err,
          data: { text: err.rawText, validationErrors: err.validationErrors },
        };
      }
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}
