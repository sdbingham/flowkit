# API reference

Complete reference for all public exports from `@db-lyon/flowkit`.

## Config

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/config`*

### `loadConfig(options)`

Load, layer, and validate YAML configuration files.

```typescript
function loadConfig<T extends z.ZodType>(
  options: LoadConfigOptions<T>,
): LoadedConfig<z.infer<T>>
```

**`LoadConfigOptions<T>`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | `string` | yes | Primary config filename (e.g., `'app.yml'`) |
| `schema` | `z.ZodType` | yes | Zod schema applied after merging all layers |
| `defaults` | `unknown` | no | Built-in defaults merged under the project file |
| `env` | `string` | no | Environment name — loads `{base}.{env}.{ext}` overlay |
| `envVar` | `string` | no | Env var to read environment name from when `env` is not passed |
| `configDir` | `string` | no | Directory to search (default: `process.cwd()`) |

**`LoadedConfig<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `config` | `T` | The validated, merged configuration object |
| `configDir` | `string` | The directory the config was loaded from |

---

### `findConfigFile(filename, startDir?)`

Walk up parent directories looking for a file by name.

```typescript
function findConfigFile(filename: string, startDir?: string): string
```

Returns the absolute path. Throws if not found.

---

### `loadRawYaml(filePath)`

Parse a YAML file and return the raw result (no schema validation).

```typescript
function loadRawYaml(filePath: string): unknown
```

---

### `deepMerge(base, override)`

Recursively merge two values. Objects merge key-by-key, arrays replace (unless `__merge: 'append'`), scalars override, `null` nullifies, `undefined` is a no-op.

```typescript
function deepMerge(base: unknown, override: unknown): unknown
```

---

### Zod schemas

| Schema | Validates |
|--------|-----------|
| `TaskOptionsSchema` | `Record<string, unknown>` |
| `TaskDefinitionSchema` | Task definition object |
| `FlowStepSchema` | Single flow step (task xor flow) |
| `FlowDefinitionSchema` | Flow with description and steps |
| `EngineConfigSchema` | Top-level config with `tasks` and `flows` |

---

### Config types

```typescript
type TaskOptions = Record<string, unknown>;

type TaskDefinition = {
  class_path: string;
  description?: string;
  group?: string;
  options: TaskOptions;  // defaults to {}
};

type FlowStep = {
  task?: string;
  flow?: string;
  options?: TaskOptions;
};

type FlowDefinition = {
  description: string;
  steps: Record<string, FlowStep>;
};

type EngineConfig = {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
};
```

---

## Task

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/task`*

### `BaseTask<TOpts>`

Abstract base class for all tasks.

```typescript
abstract class BaseTask<TOpts = Record<string, unknown>> {
  protected ctx: TaskContext;
  protected options: TOpts;
  protected logger: Logger;

  constructor(ctx: TaskContextInput, options: TOpts);

  abstract get taskName(): string;
  abstract execute(): Promise<TaskResult>;
  protected validate(): void;
  async run(): Promise<TaskResult>;
}
```

| Method | Description |
|--------|-------------|
| `taskName` | (getter) Human-readable name for logging |
| `execute()` | Perform the task's work. Return a `TaskResult`. |
| `validate()` | Optional. Called before `execute()`. Throw to abort. |
| `run()` | Lifecycle wrapper: validate → execute → catch errors → add duration. Called by the flow runner. |

---

### `TaskContext`

```typescript
type ExecutionPhase =
  | 'task'
  | 'on_start'
  | 'on_success'
  | 'on_failure'
  | 'finally'
  | 'rollback';

interface TaskContext {
  readonly executionPhase?: ExecutionPhase;
  logger?: Logger;
  /** Cancels LLM work and retry backoff owned by this task invocation. */
  readonly signal?: AbortSignal;
  [key: string]: unknown;
}

// Alias of TaskContext, named for the host boundary it documents.
type TaskContextInput = TaskContext;

// What a running task observes: Flowkit resolved the phase at construction.
type ResolvedTaskContext = TaskContext & {
  readonly executionPhase: ExecutionPhase;
};
```

`executionPhase` is optional on `TaskContext` so that a host context interface
built on it (`interface FlowContext extends TaskContext { ... }`) stays
constructible without naming a phase Flowkit owns. Inside a task, read
`this.executionPhase`, which is always resolved:

```typescript
protected get executionPhase(): ExecutionPhase;
```

Each task receives a fresh context whose `executionPhase` identifies why that
specific invocation is running. Ordinary steps, nested-flow steps, direct
`runTask` calls, task-to-task calls, and agent/tool work use `task`. Hook tasks
use their named phase, and rollback-record invocations use `rollback`.

When a host supplies `context.signal`, `AgentTask` and `AgentPromptTask` forward
that host/run-scoped signal to their LLM requests, including structured-output
repair calls. A direct task may instead receive its own invocation signal. YAML
and configuration schemas do not accept signals or functions.

Hosts continue to pass their shared services through `FlowRunnerConfig.context`
without setting a phase. Flowkit owns the field and derives it per invocation;
tasks should only read it.

---

### `TaskResult`

```typescript
interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: Error;
  duration?: number;  // milliseconds, set by run()
}
```

---

### `ShellTask`

Built-in task that executes shell commands through the platform shell with
streamed stdout and stderr.

```typescript
class ShellTask extends BaseTask<ShellTaskOptions> {
  get taskName(): string;       // "shell:{command}"
  protected validate(): void;   // requires command
  async execute(): Promise<TaskResult>;
}
```

**`ShellTaskOptions`**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | `string` | (required) | Shell command to execute |
| `cwd` | `string` | `undefined` | Working directory |
| `timeout` | `number` | `300000` | Timeout in milliseconds (5 min) |
| `signal` | `AbortSignal` | `undefined` | Cancels this individual programmatic invocation; not representable in YAML |

**Success result:** `data.output` contains trimmed stdout.

**Failure result:** `data.exitCode`, `data.stderr`, `data.stdout`.

When `signal` is already aborted, no shell process is launched and the task
returns the normal failed result with `Shell command cancelled`. An abort during
execution requests termination of the spawned shell process. On Windows,
Flowkit makes a best-effort `taskkill /T /F` request for that invocation's
shell PID and falls back to direct shell termination only if that request
fails or the five-second terminal deadline expires. On POSIX,
signal-bearing invocations run in a dedicated process group. Flowkit requests
`SIGTERM`, allows 250ms for cooperative cleanup, and then escalates the group
to `SIGKILL`. Neither approach guarantees termination of descendants that have
escaped the managed process tree or group; callers must not treat the returned
result as proof of complete descendant termination.

For signal-bearing invocations, Flowkit waits for the spawned shell to close
after requesting termination. If the operating system does not report closure
within one second on POSIX or five seconds on Windows, it returns the
cancellation or timeout result with the output captured so far; that bounded
fallback requests force termination and releases Flowkit's Node handles for
the root shell and any Windows `taskkill` helper, but is not confirmation that
either process, or any escaped descendant, has
exited. POSIX
signal-bearing invocations are in a separate process group, so terminal Ctrl+C
does not reach them automatically; cancel through the supplied `AbortSignal`.

Trailing stdout and stderr fragments are captured once. This corrects the
duplicate final-partial-line output in earlier releases.

---

### `TaskRegistry`

Registry that maps names and class paths to task constructors.

```typescript
class TaskRegistry {
  register(name: string, ctor: TaskConstructor): this;
  registerClassPath(classPath: string, ctor: TaskConstructor): this;
  registerAll(entries: Record<string, TaskConstructor>): this;
  registerClassPaths(entries: Record<string, TaskConstructor>): this;
  async resolve(classPathOrName: string): Promise<TaskConstructor>;
  async create(
    classPathOrName: string,
    ctx: TaskContextInput,
    options: Record<string, unknown>,
  ): Promise<BaseTask>;
  listRegistered(): string[];
}
```

| Method | Description |
|--------|-------------|
| `register(name, ctor)` | Register by short name |
| `registerClassPath(path, ctor)` | Register by dotted class path |
| `registerAll(entries)` | Bulk register by short name |
| `registerClassPaths(entries)` | Bulk register by class path |
| `resolve(nameOrPath)` | Look up a constructor. Falls back to dynamic filesystem import. |
| `create(nameOrPath, ctx, opts)` | Resolve + instantiate in one call; omitted phase defaults to `task` |
| `listRegistered()` | Return all registered names and class paths |

**`TaskConstructor`**

```typescript
type TaskConstructor = new (
  ctx: TaskContext,
  options: Record<string, unknown>,
) => BaseTask;
```

`TaskRegistry.create()` derives the complete invocation context before
construction. `resolve()` returns the registered or dynamically loaded
constructor itself; a caller that instantiates a resolved constructor directly
gets the same defaulting from `BaseTask`, so it does not need to supply a phase.

---

## Flow

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/flow`*

### `FlowRunner`

Orchestration engine that executes flows.

```typescript
class FlowRunner {
  constructor(config: FlowRunnerConfig);
  async run(options: FlowRunOptions): Promise<FlowRunResult>;
  resolveExecutionPlan(
    flow: FlowDefinition,
    skipSet: Set<string>,
  ): PlanStep[];
}
```

---

### `FlowRunnerConfig`

```typescript
interface FlowRunnerConfig {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  registry: TaskRegistry;
  context: TaskContextInput;
  hooks?: FlowRunnerHooks;
  logger?: Logger;
  conditionEvaluator?: ConditionEvaluator;
  references?: Record<string, unknown>;
  agents?: Record<string, AgentDefinition>;
  nestedAgentTaskFactory?: NestedAgentTaskFactory;
}
```

`nestedAgentTaskFactory` customizes only configured sub-agents invoked through
`agent:` tools. Flowkit calls it with the fully prepared child `TaskContext` and
compiled `AgentTaskOptions`. When omitted, the behavior is equivalent to:

```typescript
(ctx, options) => new AgentTask(ctx, options)
```

Direct `AgentTask` construction, configured agents run as flow steps, registry
resolution, recursion depth, shared token ledger, references, cancellation
signals, task registry, execution phase, and tool behavior are otherwise
unchanged.

```typescript
interface NestedAgentTask {
  run(): Promise<TaskResult>;
}

type NestedAgentTaskFactory = (
  ctx: ResolvedTaskContext & { readonly executionPhase: 'task' },
  options: AgentTaskOptions,
) => NestedAgentTask;
```

---

### `FlowRunOptions`

```typescript
interface FlowRunOptions {
  flowName: string;       // name of the flow to execute
  skip?: string[];        // task names or step numbers to skip
  plan?: boolean;         // return plan without executing
}
```

---

### `FlowRunResult`

```typescript
interface FlowRunResult {
  success: boolean;
  steps: FlowStepResult[];
  duration: number;       // total milliseconds
  error?: Error;          // first error that caused failure
}
```

---

### `FlowStepResult`

```typescript
interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;       // milliseconds
}
```

---

### `PlanStep`

Represents a step in the execution plan (returned by plan mode or passed to hooks).

```typescript
interface PlanStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  skipped: boolean;
  options?: Record<string, unknown>;
}
```

---

### `FlowRunnerHooks`

```typescript
interface FlowRunnerHooks {
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  afterRun?(result: FlowRunResult): Promise<void>;
  beforeStep?(step: PlanStep): Promise<void>;
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  onStepError?(
    step: PlanStep,
    error: Error,
    completed: FlowStepResult[],
  ): Promise<void>;
}
```

| Hook | Fires | Scope |
|------|-------|-------|
| `beforeRun` | Once before execution starts | Top-level flow only |
| `afterRun` | Once after execution completes | Top-level flow only |
| `beforeStep` | Before each step executes | All steps (including nested) |
| `afterStep` | After each step completes | All steps (including nested) |
| `onStepError` | When a step fails | All steps (including nested) |

---

## DAG

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/dag`*

### `topologicalSort(nodes)`

Sort a directed acyclic graph in dependency order (dependencies first).

```typescript
function topologicalSort<T>(nodes: DagNode<T>[]): DagNode<T>[]
```

Throws `CircularDependencyError` if the graph has cycles. Throws `MissingDependencyError` if a node references a dependency that doesn't exist.

---

### `DagNode<T>`

```typescript
interface DagNode<T = unknown> {
  id: string;
  dependencies: string[];
  data: T;
}
```

---

### `CircularDependencyError`

```typescript
class CircularDependencyError extends Error {
  cycle: string[];  // e.g., ['a', 'b', 'c', 'a']
}
```

---

### `MissingDependencyError`

```typescript
class MissingDependencyError extends Error {
  nodeId: string;     // the node that has the bad dependency
  missingDep: string; // the dependency that doesn't exist
}
```

---

## Guard

*Import from `@db-lyon/flowkit` or `@db-lyon/flowkit/guard`*

A before/after pipeline around one host operation. See [guards.md](guards.md) for the guide.

### `Guard<Ctx, TResult>`

```typescript
interface Guard<Ctx extends GuardContext = GuardContext, TResult = unknown> {
  readonly name: string;
  readonly order?: number;                                  // lower runs first, default 0
  appliesTo?(ctx: Ctx): boolean | Promise<boolean>;         // default: always
  before?(ctx: Ctx): Promise<void>;                         // throw to DENY
  after?(ctx: Ctx, result: TResult): Promise<TResult | void>; // return to replace
}
```

---

### `GuardContext`

The minimum a host context must provide. Extend it with whatever the operation carries.

```typescript
interface GuardContext {
  meta: Map<string, unknown>;  // scratch space shared across guards for one operation
}

function guardContextBase(): GuardContext
```

---

### `lazy(ctx, key, compute)`

Wrap a computation so it runs at most once per operation, cached into `ctx.meta` under `key`.

```typescript
function lazy<T>(ctx: GuardContext, key: string, compute: () => T): () => T
```

---

### `GuardRegistry<Ctx, TResult>`

Ordered set of guards. Sorted on registration by `order`, then by name.

```typescript
class GuardRegistry<Ctx extends GuardContext = GuardContext, TResult = unknown> {
  register(guard: Guard<Ctx, TResult>): this;
  registerAll(guards: Iterable<Guard<Ctx, TResult>>): this;
  list(): readonly Guard<Ctx, TResult>[];
  names(): string[];
  get size(): number;
}
```

---

### `runGuarded(ctx, registry, invoke)`

Run one operation through the pipeline: `before` in order, `invoke`, `after` in reverse.

```typescript
function runGuarded<Ctx extends GuardContext, TResult>(
  ctx: Ctx,
  registry: GuardRegistry<Ctx, TResult>,
  invoke: () => Promise<TResult>,
): Promise<TResult>
```

Applicability resolves once, up front. A `before` throw denies the operation and propagates unchanged. With an empty registry this is exactly `invoke()`.

---

### `discoverTaskGuards(registry, options)`

Build a `Guard` for every `guard.<name>.<before|after><Scope?>` task in a `TaskRegistry`.

```typescript
function discoverTaskGuards<Ctx extends GuardContext, TResult = unknown>(
  registry: TaskRegistry,
  options: DiscoverTaskGuardsOptions<Ctx, TResult>,
): Guard<Ctx, TResult>[]

interface DiscoverTaskGuardsOptions<Ctx extends GuardContext, TResult = unknown> {
  scopes?: Record<string, (ctx: Ctx) => boolean | Promise<boolean>>;
  contextFor(ctx: Ctx): TaskContext;
  optionsFor(ctx: Ctx, result?: TResult): Record<string, unknown>;
  onDeny?(info: GuardTaskFailure<Ctx>): Error;
  onError?(info: GuardTaskFailure<Ctx>): Error;
  onAfterFailure?(info: GuardTaskFailure<Ctx>): void;
  logger?: Logger;
}

interface GuardTaskFailure<Ctx extends GuardContext> {
  readonly guard: string;     // 'p4' for guard.p4.beforeWrite
  readonly phase: string;     // 'beforeWrite'
  readonly taskName: string;  // 'guard.p4.beforeWrite'
  readonly ctx: Ctx;
  readonly reason: string;
  readonly cause?: Error;
}
```

Throws at discovery if a task names a scope the host did not register.

---

## Logger

*Import from `@db-lyon/flowkit`*

### `Logger` interface

```typescript
interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

Compatible with pino, winston, and similar structured loggers.

### `noopLogger`

A silent logger that discards all output. Used as the default when no logger is provided.

```typescript
const noopLogger: Logger;
```
