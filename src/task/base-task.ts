import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { TaskRegistry } from './registry.js';
import type { LLMProvider, LLMToolHandler } from './llm-provider.js';
import type { TaskDefinition } from '../config/schema.js';
import type { TokenLedger } from './token-ledger.js';
import type { ReferenceContext } from '../references.js';
import { resolveTaskCall } from './task-resolution.js';

/**
 * Ambient state handed to a task at construction.
 *
 * `FlowRunner` derives a fresh context per invocation so each task carries its
 * own `taskReferenceContext` (see below). Treat it as **read-only**: writing a
 * key onto `ctx` inside a task does not reach the next step, another task, or a
 * sub-agent. Share state through a mutable object placed on the context by the
 * host instead, e.g. `context: { cache: new Map() }`.
 */
export interface TaskContext {
  /**
   * Lifecycle phase for this specific task invocation. Optional here because
   * this is the shape a *host* builds, and Flowkit owns the value: the runner
   * and `TaskRegistry.create` supply it before a task ever observes it. A
   * running task reads it through `ResolvedTaskContext`, where it is required.
   */
  readonly executionPhase?: ExecutionPhase;
  logger?: Logger;
  registry?: TaskRegistry;
  /** LLM provider consumed by `AgentPromptTask` / `AgentTask`. */
  llm?: LLMProvider;
  /** Host-provided cancellation signal observed by this task's LLM calls and retry backoff. */
  readonly signal?: AbortSignal;
  /** Programmatic agent tools, keyed by the name exposed to the model. */
  agentTools?: Record<string, LLMToolHandler>;
  /**
   * Configured task definitions, supplied by `FlowRunner`, so that tasks used
   * as agent tools inherit their configured `class_path` and `options` defaults.
   */
  taskDefinitions?: Record<string, TaskDefinition>;
  /**
   * Reference scope for `${ns.path}` interpolation of a called task's
   * *configured defaults*. Supplied by `FlowRunner` and propagated into nested
   * tasks and sub-agents, so a task resolves the same references however deep
   * it is invoked. Options passed at the call site are runtime data and are
   * never interpolated.
   */
  taskReferenceContext?: ReferenceContext;
  /**
   * Run a configured flow as an agent tool. Wired by `FlowRunner`; absent when
   * a task runs outside one. Returns a task-shaped result whose `data.steps`
   * maps each step name to its output.
   */
  runFlow?: (flowName: string, params?: Record<string, unknown>) => Promise<TaskResult>;
  /**
   * Run a configured agent as an agent tool (the sub-agent fan-out path). Wired
   * by `FlowRunner`. `depth` carries the caller's depth + 1 for recursion
   * bounding; `AgentTask` passes it through.
   */
  runAgent?: (
    agentName: string,
    input: Record<string, unknown>,
    depth: number,
    ledger?: TokenLedger,
  ) => Promise<TaskResult>;
  /** Current agent-recursion depth, threaded by `FlowRunner.runAgent`. */
  __agentDepth?: number;
  /**
   * Shared token ledger for the current agent subtree, threaded by
   * `FlowRunner.runAgent` so a parent's `tokenBudget` bounds its sub-agents too.
   */
  __tokenLedger?: TokenLedger;
  [key: string]: unknown;
}

/** Public lifecycle phases assigned by `FlowRunner` to each task invocation. */
export type ExecutionPhase =
  | 'task'
  | 'on_start'
  | 'on_success'
  | 'on_failure'
  | 'finally'
  | 'rollback';

/**
 * Host context accepted by runners and direct task construction.
 *
 * An alias of `TaskContext`, named for the boundary it documents. It is not an
 * `Omit<TaskContext, 'executionPhase'>`: `TaskContext` carries a string index
 * signature, so `keyof` it is `string | number` and `Omit` would erase every
 * named field, silently turning the host-facing surface into `{[k: string]:
 * unknown}` and dropping all compile-time checking of `logger`, `llm`, and the
 * rest.
 */
export type TaskContextInput = TaskContext;

/**
 * Context as a *running task* observes it: identical to `TaskContext` except
 * the lifecycle phase is guaranteed present, because Flowkit resolved it during
 * construction. This is the type of `BaseTask.ctx`.
 */
export type ResolvedTaskContext = TaskContext & {
  readonly executionPhase: ExecutionPhase;
};

/**
 * Phase used when nothing better is known: direct construction, or a
 * `registry.create()` whose caller supplied no phase. Declared once and
 * referenced everywhere, so adding a phase or changing the fallback is a
 * single-site edit rather than a hunt through the runner and the registry.
 */
export const DEFAULT_EXECUTION_PHASE: ExecutionPhase = 'task';

/**
 * The one place a host context becomes a task context.
 *
 * Returns `ctx` **itself** when the phase is already set, which is every path
 * through `FlowRunner`. That matters beyond allocation: a host may pass a class
 * instance or a service object as its context, and copying would strip its
 * prototype methods and break identity for anything comparing contexts. When a
 * phase must be added, the prototype is carried onto the new object for the
 * same reason.
 */
export function resolveTaskContext(ctx: TaskContextInput): ResolvedTaskContext {
  if (ctx.executionPhase !== undefined) return ctx as ResolvedTaskContext;
  const proto = Object.getPrototypeOf(ctx) as object | null;
  return Object.assign(Object.create(proto) as TaskContext, ctx, {
    executionPhase: DEFAULT_EXECUTION_PHASE,
  }) as ResolvedTaskContext;
}

/**
 * Rollback record returned by a successful mutation task.
 * The runner invokes `taskName` with `payload` (in reverse step order)
 * when `rollback_on_failure` is enabled and a subsequent step fails.
 */
export interface RollbackRecord {
  taskName: string;
  payload: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: Error;
  duration?: number;
  rollback?: RollbackRecord;
}

export abstract class BaseTask<TOpts = Record<string, unknown>> {
  protected logger: Logger;
  /**
   * Typed `TaskContext`, not `ResolvedTaskContext`, so a subclass can narrow it
   * to the host's own context interface (which is built from `TaskContext` and
   * so leaves the phase optional). The value is always phase-resolved at
   * runtime; a task that needs the non-optional type can assert
   * `ResolvedTaskContext`.
   */
  protected ctx: TaskContext;
  protected options: TOpts;

  constructor(ctx: TaskContextInput, options: TOpts) {
    this.ctx = resolveTaskContext(ctx);
    this.options = options;
    const parentLogger = this.ctx.logger ?? noopLogger;
    this.logger = parentLogger.child({ task: this.constructor.name });
  }

  /**
   * Lifecycle phase for this invocation, always present. Read this rather than
   * `ctx.executionPhase`: `ctx` is typed as the host-facing `TaskContext`, where
   * the phase is optional so host context interfaces stay constructible, but
   * Flowkit resolves it before any task observes it.
   */
  protected get executionPhase(): ExecutionPhase {
    return (this.ctx as ResolvedTaskContext).executionPhase;
  }

  abstract get taskName(): string;

  abstract execute(): Promise<TaskResult>;

  /** Override for option validation — called before execute(). */
  protected validate(): void {}

  /**
   * Resolve another task by its configured name or class path from the registry.
   *
   * A FlowRunner supplies configured definitions on the context. Honor that
   * indirection here too: task-to-task calls must use the same class_path and
   * default options as an ordinary flow step or an agent tool, including
   * `${ns.path}` interpolation of those defaults. `options` are this task's own
   * runtime data and stay literal (see `resolveTaskCall`).
   * The child receives a fresh context with the ordinary `task` phase while
   * retaining the caller's host services and reference scope.
   *
   * Returns an unexecuted task instance — call `.run()` on it yourself when you
   * need to inspect or configure the task before running.
   */
  protected async resolve<T extends BaseTask = BaseTask>(
    taskName: string,
    options?: Record<string, unknown>,
  ): Promise<T> {
    const registry = this.ctx.registry;
    if (!registry) {
      throw new Error(
        `Cannot resolve task "${taskName}" — no registry in context. ` +
          'Tasks can only resolve other tasks when run via FlowRunner.',
      );
    }
    const resolved = resolveTaskCall(
      taskName,
      this.ctx.taskDefinitions,
      options,
      this.ctx.taskReferenceContext,
    );
    // A task-to-task call is ordinary work: it does not inherit the caller's
    // hook or rollback phase.
    const childCtx: TaskContext = { ...this.ctx, executionPhase: DEFAULT_EXECUTION_PHASE };
    return registry.create(resolved.classPath, childCtx, resolved.options) as Promise<T>;
  }

  /**
   * Resolve and execute another task by name in a single call.
   * The resolved task shares the caller's host services through a fresh context.
   */
  protected async call(
    taskName: string,
    options?: Record<string, unknown>,
  ): Promise<TaskResult> {
    const task = await this.resolve(taskName, options);
    return task.run();
  }

  /**
   * Lifecycle wrapper: validate → execute → return result.
   * Catches exceptions and returns `{ success: false }` instead of throwing.
   */
  async run(): Promise<TaskResult> {
    const startTime = Date.now();

    this.logger.debug({ options: this.options }, `Starting task: ${this.taskName}`);

    try {
      this.validate();
      const result = await this.execute();
      result.duration = Date.now() - startTime;

      this.logger.debug(
        { success: result.success, duration: result.duration },
        `Completed task: ${this.taskName}`,
      );

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error({ error, duration }, `Failed task: ${this.taskName}`);

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        duration,
      };
    }
  }
}
