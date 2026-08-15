# Release notes

## 0.17.0

`AgentTaskOptions` and `AgentPromptOptions` now accept an optional programmatic
`retryOn(err: Error) => boolean` predicate. Flowkit forwards it unchanged to
the shared completion runner for normal turns and structured-answer completion.
When omitted, retry behavior is unchanged: non-cancellation provider failures
retry according to the configured/default retry count and delay. `AgentRunFields` and agent
YAML/config schemas remain plain-data only; this function-valued `retryOn` is
host-owned and must be supplied in code. It is distinct from the existing
flow-step `retryOn` string matcher.

Agent and prompt tasks now also forward the host/run-scoped
`TaskContext.signal` supplied through `FlowRunner` to every completion and
repair turn; directly constructed tasks may instead receive an
invocation-specific signal. Cancellation prevents new attempts during retry
backoff, while the completion runner removes listeners used to combine request
and timeout signals on every terminal path.

`LLMAbortError` is exported from the root and `./task` entrypoints so hosts can
recognize the generic cancellation outcome with `instanceof` when needed.

On Windows, ShellTask now allows its bounded `taskkill /T /F` tree-termination
operation up to five seconds before releasing the command root. This reduces
the chance of ending the helper early on a loaded host while retaining a
bounded cancellation result.

## 0.16.0

FlowRunner now accepts a provider-agnostic nested agent task factory for
configured sub-agents invoked through `agent:` tools:

```typescript
interface NestedAgentTask {
  run(): Promise<TaskResult>;
}

type NestedAgentTaskFactory = (
  ctx: ResolvedTaskContext & { readonly executionPhase: 'task' },
  options: AgentTaskOptions,
) => NestedAgentTask;

new FlowRunner({
  // ...
  nestedAgentTaskFactory: (ctx, options) => new AgentTask(ctx, options),
});
```

The default remains equivalent to `new AgentTask(ctx, options)`, so existing
consumers do not need to change. Hosts that wrap Flowkit tasks can use the
factory to preserve their own task subclass or task construction policy for
nested `agent:` tool execution without changing direct `AgentTask` behavior or
using global registration.

## 0.15.0

Flowkit now exposes a generic execution-lifecycle contract on every task:

```typescript
type ExecutionPhase =
  | 'task'
  | 'on_start'
  | 'on_success'
  | 'on_failure'
  | 'finally'
  | 'rollback';

// Inside a task:
protected get executionPhase(): ExecutionPhase;
```

The runner derives a fresh context for each invocation. Ordinary work,
including nested flows, direct task calls, task-to-task calls, agents, and
tools, receives `task`; hooks and rollback invocations receive their matching
phase. A nested flow or sub-agent cannot carry its caller's phase into its own
ordinary work.

This is additive for hosts, including at the type level. `executionPhase` is
**optional** on `TaskContext`, so a host context interface built on it stays
constructible without naming a phase:

```typescript
interface FlowContext extends TaskContext, ToolContext {}
const ctx: FlowContext = { bridge, project }; // still compiles
```

Making the field required would have broken every downstream context type that
extends `TaskContext`, which is why it is not. Inside a task, read
`this.executionPhase` rather than `this.ctx.executionPhase`: the accessor is
typed `ExecutionPhase` with no `undefined`, because Flowkit resolves the value
before any task observes it. `ResolvedTaskContext` names that resolved shape for
code that needs the type directly.

`TaskRegistry.create()` accepts host-style context without an `executionPhase`
and derives `task` before construction. Code that calls `registry.resolve()` and
directly instantiates the returned constructor gets the same defaulting from
`BaseTask`, so it does not need to supply a phase either.

Guard hosts are unaffected: `DiscoverTaskGuardsOptions.contextFor` returns
`TaskContext`, unchanged from 0.14.0.

The context a host passes is no longer copied when it already carries a phase,
which is every path through `FlowRunner`. A host may therefore pass a class
instance or service object as its context and keep its prototype methods and
object identity; previously each invocation shallow-copied it. `Flowkit` exports
`resolveTaskContext` and `DEFAULT_EXECUTION_PHASE` for hosts that construct
tasks themselves and want the same normalization.

A string `when:` condition now receives the phase of the step it gates, so a
`finally` hook gating on `context.executionPhase` sees `'finally'` rather than
the runner's seed value.
