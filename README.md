# @db-lyon/flowkit

YAML-configured task and flow orchestration engine for Node.js.

Define reusable **tasks** and compose them into **flows** using declarative YAML. Flowkit handles config layering, task resolution, sequential execution, nested flows, lifecycle hooks, and more.

## Install

```bash
npm install @db-lyon/flowkit
```

Requires Node.js >= 20.

## Quick start

**1. Define your config** (`pipeline.yml`):

```yaml
tasks:
  build:
    class_path: tasks.Build
    description: Compile the project
    options:
      target: production

  test:
    class_path: tasks.Test
    description: Run the test suite

  deploy:
    class_path: tasks.Deploy
    description: Deploy artifacts

flows:
  ci:
    description: Build, test, deploy
    steps:
      1:
        task: build
      2:
        task: test
      3:
        task: deploy
        options:
          environment: staging
```

**2. Create a task** (`tasks/Build.ts`):

```typescript
import { BaseTask, type TaskResult } from '@db-lyon/flowkit';

interface BuildOptions {
  target: string;
}

export default class Build extends BaseTask<BuildOptions> {
  get taskName() { return 'build'; }

  protected validate() {
    if (!this.options.target) throw new Error('target is required');
  }

  async execute(): Promise<TaskResult> {
    this.logger.info(`Building for ${this.options.target}`);
    // ... do work ...
    return { success: true, data: { target: this.options.target } };
  }
}
```

**3. Run it**:

```typescript
import {
  loadConfig,
  EngineConfigSchema,
  TaskRegistry,
  FlowRunner,
} from '@db-lyon/flowkit';

const { config } = loadConfig({
  filename: 'pipeline.yml',
  schema: EngineConfigSchema,
  configDir: './config',
});

const registry = new TaskRegistry();
// Tasks with class_path like "tasks.Build" are resolved dynamically
// from the filesystem (tasks/Build.ts), or register them explicitly:
// registry.register('build', Build);

const runner = new FlowRunner({
  tasks: config.tasks,
  flows: config.flows,
  registry,
  context: { logger: console },
});

const result = await runner.run({ flowName: 'ci' });
console.log(result.success); // true
```

## Features

### YAML-driven configuration

Define tasks and flows in YAML. Each task references a `class_path` (resolved to a file on disk or a registered constructor) and can carry default `options`. Flows are ordered sequences of steps that reference tasks or other flows.

### Config layering

The config loader merges multiple YAML files in order:

```
defaults (code)  →  pipeline.yml  →  pipeline.staging.yml  →  pipeline.local.yml
```

```typescript
const { config } = loadConfig({
  filename: 'pipeline.yml',
  schema: EngineConfigSchema,
  env: 'staging',          // loads pipeline.staging.yml overlay
  configDir: './config',
});
```

Environment overlays and `.local.yml` files let you customize per-environment or per-developer without touching the base config. See [docs/configuration.md](docs/configuration.md).

### Custom tasks

Extend `BaseTask` to create your own tasks. The lifecycle is: `validate()` → `execute()` → result with timing. Exceptions are caught and returned as `{ success: false }` automatically.

```typescript
class MyTask extends BaseTask<MyOptions> {
  get taskName() { return 'my_task'; }
  async execute(): Promise<TaskResult> {
    return { success: true };
  }
}
```

See [docs/custom-tasks.md](docs/custom-tasks.md).

### Built-in ShellTask

Run shell commands without writing a custom task class:

```yaml
tasks:
  lint:
    class_path: shell
    options:
      command: npm run lint
      cwd: /path/to/project
      timeout: 60000
```

Register it in your registry:

```typescript
import { ShellTask } from '@db-lyon/flowkit';
registry.register('shell', ShellTask as any);
```

Existing YAML consumers need no change. To cancel one programmatic invocation,
pass an invocation-specific `AbortSignal`:

```typescript
const controller = new AbortController();
const result = await new ShellTask({}, {
  command: 'npm run build',
  signal: controller.signal,
}).run();
```

### AI agents

Run LLM calls as steps. Flowkit has **no SDK dependencies** — you wire a
model-agnostic `LLMProvider` onto the task context as `ctx.llm`, and two tasks
consume it:

- `agent_prompt` (`AgentPromptTask`) — single-shot prompt, with optional
  JSON-Schema structured output (validated, with a repair re-prompt).
- `agent` (`AgentTask`) — a tool-calling loop. Tools reference flowkit tasks,
  flows, or other agents (or context handlers), gated by an allowlist and
  per-tool argument validation. Multiple tool calls in a turn (including
  parallel sub-agents) run concurrently under a cap.

Reusable agents live under an `agents:` root key and run as flow steps or as
other agents' tools, with mandatory budgets (`maxIterations`, `tokenBudget`,
`maxAgentDepth`). Iteration and concurrency live in the agent runtime, so a flow
stays a sequential spine with no `loop:` or parallel-step primitive.

Hosts can optionally pass `nestedAgentTaskFactory` to `FlowRunner` to control the
task object used only for configured sub-agents invoked through `agent:` tools.
When omitted, Flowkit behaves as if it constructed `new AgentTask(ctx, options)`.
Agents run directly as flow steps still use the normal registry path.

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

Every call is hardened by a shared core: per-call `timeout` (with provider
abort), `retries` with exponential backoff, structured-output validation +
repair, and output-size caps. See [docs/ai-agents.md](docs/ai-agents.md).

### Nested flows

A step can reference another flow instead of a task:

```yaml
flows:
  ci:
    description: CI pipeline
    steps:
      1: { task: build }
      2: { task: test }

  release:
    description: Full release
    steps:
      1: { flow: ci }
      2: { task: deploy }
```

A flow step's `options` override the options of tasks **inside** the nested
flow, keyed by task name. Precedence, low → high: task default → enclosing-flow
override → step's own inline options → runtime `params`.

```yaml
release:
  steps:
    1:
      flow: ci
      options:
        test: { coverage: 90 } # overrides the `test` task's options inside `ci`
    2: { task: deploy }
```

### Conditional steps (`when`)

A step runs only when its `when` is truthy. It accepts a boolean, or a string
expression evaluated at run time. With no `conditionEvaluator` configured, a
string is resolved for `${...}` references and tested for truthiness; supply a
`conditionEvaluator` to plug in a real expression language. A falsy result skips
the step (`skipReason: 'when'`) without failing the flow.

```yaml
steps:
  1: { task: build }
  2: { task: deploy, when: '${steps.1.shouldDeploy}' }
  3: { task: notify, when: false }
```

```typescript
new FlowRunner({
  // ...
  conditionEvaluator: (expr, ctx) => evalMyDsl(expr, ctx), // ctx: { steps, params, context, error }
});
```

### Continue on failure (`ignore_failure`)

By default any failed step aborts the flow. Mark a step `ignore_failure: true`
to record the failure but keep going (the step result has `ignoredFailure: true`).

```yaml
steps:
  1: { task: deploy }
  2: { task: publish_release_notes, ignore_failure: true }
  3: { task: announce }
```

### Skip steps

Skip by task name or step number:

```typescript
await runner.run({ flowName: 'release', skip: ['deploy'] });
await runner.run({ flowName: 'release', skip: ['2'] });
```

Or mark a step as permanently skipped in YAML:

```yaml
steps:
  3:
    task: None
```

### Plan mode

Preview the execution plan without running anything:

```typescript
const result = await runner.run({ flowName: 'ci', plan: true });
result.steps.forEach(s =>
  console.log(`${s.stepNumber}: [${s.type}] ${s.name}${s.skipped ? ' (skip)' : ''}`)
);
```

Pass `expandNestedFlows: true` to recursively expand nested-flow steps into
their child steps, each annotated with a hierarchical `path` (e.g. `2/1`):

```typescript
await runner.run({ flowName: 'release', plan: true, expandNestedFlows: true });
```

### Lifecycle hooks

Attach hooks to observe or react to flow execution:

```typescript
const runner = new FlowRunner({
  // ...
  hooks: {
    beforeRun: async (flowName, plan) => { /* ... */ },
    beforeStep: async (step) => { /* ... */ },
    afterStep: async (step, result) => { /* ... */ },
    onStepError: async (step, error, completed) => { /* ... */ },
    afterRun: async (result) => { /* ... */ },
  },
});
```

`beforeRun`/`afterRun` fire once for the top-level flow. `beforeStep`/`afterStep` fire for every step including those inside nested flows.

### DAG utilities

Topological sort with cycle and missing-dependency detection:

```typescript
import { topologicalSort } from '@db-lyon/flowkit';

const sorted = topologicalSort([
  { id: 'a', dependencies: [], data: null },
  { id: 'b', dependencies: ['a'], data: null },
  { id: 'c', dependencies: ['a', 'b'], data: null },
]);
// sorted: [a, b, c]
```

Throws `CircularDependencyError` or `MissingDependencyError` on invalid graphs.

### Logger interface

Flowkit accepts any logger that implements the `Logger` interface (compatible with pino, winston, etc.):

```typescript
interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

Pass it via the task context or flow runner config. A `noopLogger` is used by default.

## Sub-path exports

```typescript
import { loadConfig } from '@db-lyon/flowkit/config';
import { BaseTask, TaskRegistry } from '@db-lyon/flowkit/task';
import { FlowRunner } from '@db-lyon/flowkit/flow';
import { topologicalSort } from '@db-lyon/flowkit/dag';
```

## Docs

- [Getting started](docs/getting-started.md) — step-by-step setup guide
- [Custom tasks](docs/custom-tasks.md) — writing and registering tasks
- [AI agents](docs/ai-agents.md) — LLM prompts, structured output, tool-calling agents
- [Configuration](docs/configuration.md) — YAML schema, layering, deep merge
- [Guards](docs/guards.md) — before/after pipeline around a host operation
- [API reference](docs/api-reference.md) — full type and function reference

## License

MIT — see [LICENSE](LICENSE).
