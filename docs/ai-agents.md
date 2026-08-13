# AI agents

Flowkit can drive LLM calls as ordinary steps. A flow can mix deterministic
tasks with steps that prompt a model, extract structured data, or run a
tool-calling agent — and the model output flows into later steps through the
same `${steps.<id>.<path>}` references as anything else.

Flowkit ships **no SDK dependencies**. You supply a provider that adapts your
model of choice to a small neutral contract; the engine stays model-agnostic.

## Wiring a provider

Implement `LLMProvider` and attach it to the task context as `llm`. The
provider's only job is to translate flowkit's neutral request/response shape to
and from your SDK.

```typescript
import { FlowRunner, type LLMProvider } from '@db-lyon/flowkit';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const provider: LLMProvider = {
  async complete(req) {
    const res = await client.messages.create(
      {
        model: req.model ?? 'claude-opus-4-8',
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        temperature: req.temperature,
        messages: toAnthropicMessages(req),   // map req.prompt / req.messages
        tools: req.tools?.map(toAnthropicTool),
      },
      { signal: req.signal },                  // honor cancellation/timeout
    );
    return {
      text: textOf(res),
      toolCalls: toolCallsOf(res),
      finishReason: res.stop_reason ?? undefined,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model: res.model,
    };
  },
};

const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  registry,
  context: { logger, llm: provider },          // <- the seam
});
```

A provider may ignore any field it does not support. A request that only sets
`prompt` works against the simplest possible adapter.

> Model id, pricing, and SDK specifics for Claude live in the `claude-api`
> reference — don't hard-code a stale model id.

## Single-shot prompts — `AgentPromptTask`

`class_path: agent_prompt`. One prompt in, one response out. Register it:

```typescript
import { AgentPromptTask } from '@db-lyon/flowkit';
registry.register('agent_prompt', AgentPromptTask as any);
```

```yaml
tasks:
  summarize:
    class_path: agent_prompt
    options:
      system: You extract action items from meeting notes.
      prompt: "Summarize:\n${steps.1.text}"
```

`result.data`: `text` (always), plus `parsed`, `usage`, `finishReason`, `model`,
and `truncated` when present.

### Structured output

Pass a JSON Schema. The response is validated against it; on a mismatch the
model is re-prompted with the concrete validation errors (the **repair loop**)
before the step fails.

```yaml
tasks:
  extract:
    class_path: agent_prompt
    options:
      prompt: "Pull the ticket fields from:\n${steps.1.text}"
      schema:
        type: object
        required: [title, priority]
        properties:
          title: { type: string }
          priority: { type: string, enum: [low, medium, high] }
```

On success `result.data.parsed` holds the validated object. If the model never
conforms, the step fails with a `StructuredOutputError` and `result.data.text`
carries the last raw output for debugging.

> **Reference paths are rooted at the step's `data`.** In `${steps.<id>.<path>}`,
> `<path>` is relative to that step's `result.data`, so a later step reads a
> structured field as `${steps.extract.parsed.title}` or the raw text as
> `${steps.1.text}` — **not** `${steps.1.data.text}` (that resolves to
> `data.data.text`, which is undefined). `<id>` is a step number or a task name.

The bundled validator covers the JSON Schema subset used for structured output
(`type`, `enum`, `const`, `required`, `properties`, `items`,
`additionalProperties`, length/number bounds, `anyOf`/`oneOf`/`allOf`/`not`,
and OpenAPI-style `nullable`). Unknown keywords are ignored rather than
rejected.

## Tool-calling agents — `AgentTask`

`class_path: agent`. A multi-turn loop: the model requests tool calls, the agent
runs them, feeds the results back, and repeats until the model gives a final
answer or `maxIterations` is hit.

```typescript
import { AgentTask } from '@db-lyon/flowkit';
registry.register('agent', AgentTask as any);
```

A tool references an existing flowkit primitive — a `task:`, a `flow:`, or
another `agent:` — or a **context handler** (a function on `ctx.agentTools`,
matched by `name:`). Tool dispatch reuses the registry and options machinery, so
there is no separate tool concept to maintain. A task-backed tool inherits its
configured `class_path` and `options` defaults, with the model's arguments
layered on top, so a task behaves the same as a tool as it does as a flow step.
`flow:` and `agent:` tools require a `FlowRunner` context (see "Declarative
agents" below).

```yaml
tasks:
  research:
    class_path: agent
    options:
      system: You answer questions using the available tools.
      prompt: "How many open PRs touch the auth module?"
      maxIterations: 6
      tools:
        - task: shell                 # a flowkit task, exposed to the model
          name: run_command
          description: Run a read-only shell command and return its output.
          parameters:
            type: object
            required: [command]
            properties:
              command: { type: string }
        - name: search_docs           # a ctx.agentTools handler
          description: Full-text search the internal docs.
          parameters:
            type: object
            required: [query]
            properties:
              query: { type: string }
```

```typescript
const runner = new FlowRunner({
  /* ... */
  context: {
    logger,
    llm: provider,
    agentTools: {
      search_docs: async ({ query }) => docs.search(query as string),
    },
  },
});
```

`result.data`: `text` (final answer), `iterations`, `toolCalls` (every call with
its name, arguments, `ok`, and truncated `result`), `usage` (aggregated), and
`finishReason`. Add a `schema` option to get a validated `parsed` final answer —
the agent reuses the final turn when it already conforms and only spends an
extra round-trip on the structured pass when it does not.

### Parallel tool calls

When the model requests several tools in one turn — including several sub-agents
— they execute concurrently, bounded by `maxConcurrency` (default 4), and their
results are reassembled in call order so the conversation stays deterministic.
This is the only concurrency mechanism: there is no parallel flow-step
construct. Two parallel agentic loops are modeled as two sub-agents of one
coordinating agent.

### Tool safety

- **Allowlist** — only declared tools are callable. An unknown tool name is
  reported back to the model, never executed.
- **Argument validation** — the model's arguments are checked against each
  tool's `parameters` schema before the tool runs; invalid arguments are fed
  back for the model to correct.
- **Bounded results** — each tool result is truncated to `maxToolResultChars`
  (default 8000). Sub-agent (`agent:`) results use a separate
  `maxAgentResultChars` (default unbounded) so code, diffs, and stack traces are
  not clipped mid-payload like opaque tool output.
- **Bounded loops** — `maxIterations` (default 8) caps model turns; exceeding it
  fails the step.
- **Bounded spend** — `tokenBudget` is a true aggregate ceiling: a budgeted
  agent and its entire sub-agent tree charge one shared ledger, so fan-out
  cannot multiply spend past the cap. Reaching it fails the step. Any agent
  whose toolset includes an `agent:` tool **must** set a `tokenBudget` (or run
  under an ancestor that did) — the engine rejects an unbounded fan-out.
- **Bounded recursion** — `maxAgentDepth` (default 6) caps how deep
  agents-calling-agents may nest.

## Declarative agents

Inline `agent` tasks are fine for one-offs, but agents you reuse across flows
(and that call each other) belong in the `agents:` root key of your config. It is
additive — CumulusCI never had it, so `tasks:` and `flows:` stay byte-identical.

```yaml
agents:
  developer:
    description: Researches and implements a change.
    model: claude-opus-4-8
    system: You implement the requested change using the available tools.
    tools:
      - task: shell
        name: run_command
        parameters:
          type: object
          required: [command]
          properties: { command: { type: string } }
    schema:
      type: object
      required: [summary]
      properties: { summary: { type: string } }
    budget:
      maxIterations: 8
      tokenBudget: 200000
      maxConcurrency: 4
      maxAgentDepth: 4
```

Wire the config and a provider into the runner. The runner compiles each agent,
registers the `agent` class, and enables `flow:`/`agent:` tools:

```typescript
const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  agents: config.agents,            // <- the AI-native layer
  registry,
  context: { logger, llm: provider },
});
```

Hosts that wrap task construction can customize only configured sub-agents
invoked through `agent:` tools:

```typescript
import { AgentTask, FlowRunner } from '@db-lyon/flowkit';

const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  agents: config.agents,
  registry,
  context: { logger, llm: provider },
  nestedAgentTaskFactory: (ctx, options) => new AgentTask(ctx, options),
});
```

When omitted, the default is equivalent to `new AgentTask(ctx, options)`.
Flowkit supplies the factory with the prepared child context and compiled
options used for recursion depth, shared token budget, references, cancellation
signals, registry access, execution phase, and tool dispatch. Agents run
directly as flow steps still use the normal registry path.

A declared agent is usable two ways, both through machinery that already exists:

- **As a flow step** — reference it like any task; supply its prompt in the step:

  ```yaml
  flows:
    ship:
      steps:
        1: { flow: dev_org }
        2: { task: developer, options: { prompt: "Implement ${steps.1.ticket}" } }
        3: { task: submit_pr }
  ```

- **As another agent's tool** — list it under `tools:` with `agent:`. When the
  parent calls it, the model's `prompt` argument becomes the sub-agent's input,
  and the sub-agent's result is fed back. Recursion is bounded by `maxAgentDepth`.

### The shape this targets

A flow that builds a dev org, researches and develops (with parallel sub-agents),
deploys, iterates on failed deploys, runs tests, iterates on failed tests, and
opens a PR collapses to a sequential flow spine where every loop and fork lives
inside an agent:

```yaml
agents:
  developer: { system: "...", tools: [ { agent: researcher }, { task: shell } ] }
  researcher: { system: "..." }              # fanned out as parallel sub-agents
  deployer:   { system: "...", tools: [ { task: deploy_scratch } ] }  # edit/redeploy loop
  tester:     { system: "...", tools: [ { task: run_tests }, { task: shell } ] }  # fix/retest loop

flows:
  ship:
    steps:
      1: { flow: dev_org }
      2: { task: developer, options: { prompt: "..." } }
      3: { task: deployer,  options: { prompt: "Deploy and fix failures." } }
      4: { task: tester,    options: { prompt: "Make the tests pass." } }
      5: { task: submit_pr }
```

Steps 3 and 4 are not flow loops. The fix-retest cycle is each agent's own
tool-use loop. Parallel research in step 2 is the developer emitting several
`researcher` sub-agent calls in one turn. No `loop:` and no parallel flow step
appear anywhere.

## Testing agents

Test the agent loop without a live model by passing a stub `LLMProvider` that
scripts the turns: each `complete()` call returns the next response, and a
`finishReason: 'tool_use'` response with `toolCalls` drives the loop into your
tools. Assert on the returned `data` (final `text`/`parsed`, the `toolCalls`
record, `usage`).

```typescript
import { AgentTask } from '@db-lyon/flowkit';
import type { LLMProvider, LLMCompletionResponse } from '@db-lyon/flowkit';

// Scripted provider: returns the responses in order.
function scripted(responses: LLMCompletionResponse[]): LLMProvider {
  let i = 0;
  return { async complete() { return responses[Math.min(i++, responses.length - 1)]!; } };
}

const provider = scripted([
  // turn 1: ask for a tool
  { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'add', arguments: { a: 2, b: 3 } }] },
  // turn 2: final answer
  { text: 'the sum is 5', finishReason: 'stop' },
]);

const task = new AgentTask(
  { llm: provider, agentTools: { add: ({ a, b }) => ({ sum: (a as number) + (b as number) }) } },
  { prompt: 'add 2 and 3', tools: [{ name: 'add', parameters: { type: 'object', required: ['a', 'b'] } }] },
);
const result = await task.run();
// result.data.text === 'the sum is 5'; result.data.toolCalls[0].ok === true
```

For sub-agent and flow tools, drive them through a `FlowRunner` configured with
`agents:` and a provider that branches on `req.system` so one stub can serve
several agents.

## Robustness controls

These option fields apply to both `agent_prompt` and `agent`:

| Option            | Default | Effect                                                        |
| ----------------- | ------- | ------------------------------------------------------------- |
| `timeout`         | 60000   | Per-call timeout in ms; the provider's `signal` is aborted.   |
| `retries`         | 2       | Transport retries on failure, with exponential backoff.       |
| `retryDelay`      | 500     | Base backoff in ms; doubles each retry.                       |
| `repairAttempts`  | 1       | Structured-output re-prompts before failing.                  |
| `maxOutputChars`  | 0       | Cap on response text length (0 = unlimited).                  |

Programmatic callers can use `runCompletion(provider, request, options, logger)`
directly — it is the shared core both tasks build on, and it accepts a
`retryOn(err)` predicate for fine-grained retry control.

Programmatic `AgentTaskOptions` and `AgentPromptOptions` also accept an optional
`retryOn(err)` predicate. Flowkit passes it unchanged to every completion for
that task, including retries and structured-answer completion. When omitted,
the existing retry-all behavior remains. This function-valued `retryOn` is
host-only: it is not part of `AgentRunFields` or agent YAML/config schemas.
This is distinct from Flowkit's existing flow-step `retryOn` string matcher.

When a host provides `context.signal`, agent and prompt tasks forward that
host/run-scoped signal to every provider call and retry backoff. A directly
constructed task may receive its own invocation signal. Cancellation therefore
prevents a later provider attempt; it does not become an agent YAML or
configuration field.

## Security notes

- **Prompt injection.** Templating prior step output (`${steps...}`) or feeding
  tool results (file contents, shell output) back to the model means untrusted
  text reaches it and can carry instructions. A `schema` does **not** defend
  against this — it validates the shape of *outbound* output, not the inbound
  text that carries an injection. The real control is the toolbox: an `agent`
  whose tools include `shell` can run whatever the model is talked into. Prefer
  narrow, read-only tools and scope every tool tightly.
- **Secret hygiene.** The tasks log prompts only at `debug`, and previews are
  whitespace-collapsed and length-capped. Use `redact()` before logging
  provider config so API keys and tokens never reach your logs.
- **Resource bounds.** `timeout`, `maxOutputChars`, `maxToolResultChars`, and
  `maxIterations` together bound how long a step runs, how much it can emit, and
  how far an agent can wander.
