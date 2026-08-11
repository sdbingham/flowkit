import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type { TaskDefinition, FlowDefinition, FlowStep, AgentDefinition } from '../config/schema.js';
import type {
  TaskResult,
  RollbackRecord,
  TaskContext,
  TaskContextInput,
  ResolvedTaskContext,
  ExecutionPhase,
} from '../task/base-task.js';
import { DEFAULT_EXECUTION_PHASE } from '../task/base-task.js';
import type { TaskRegistry, TaskConstructor } from '../task/registry.js';
import { AgentTask, type AgentTaskOptions } from '../task/agent-task.js';
import type { TokenLedger } from '../task/token-ledger.js';
import { resolveReferences, type ReferenceContext } from '../references.js';
import { resolveTaskDefinition, resolveTaskCall, type ResolvedTask } from '../task/task-resolution.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HookPhase = 'on_start' | 'on_success' | 'on_failure' | 'finally';

/**
 * Per-task option overrides injected by an enclosing flow step, keyed by the
 * inner task (or flow) name. When a flow step carries `options`, those options
 * are interpreted as this map and threaded down into the nested flow.
 */
export type ParentOptions = Record<string, Record<string, unknown>>;

export interface FlowRunOptions {
  flowName: string;
  skip?: string[];
  plan?: boolean;
  /** Runtime parameters — merged into every step's options with highest priority. */
  params?: Record<string, unknown>;
  /** If true, invoke rollback records from completed steps in reverse order on failure. */
  rollback_on_failure?: boolean;
  /**
   * Plan mode only: recursively expand nested-flow steps into their child steps
   * (each annotated with a hierarchical `path`). Default false preserves the
   * flat, one-line-per-flow-step plan.
   */
  expandNestedFlows?: boolean;
}

/** Context handed to a `conditionEvaluator` when resolving a string `when:`. */
export interface ConditionContext {
  steps: FlowStepResult[];
  params?: Record<string, unknown>;
  context: TaskContext;
  error?: { message: string; name: string; stack?: string; step?: string };
}

/**
 * Evaluates a string `when:` expression to a boolean. Supply one to use a real
 * expression language (e.g. jinja-style with project/org context). When absent,
 * the runner falls back to resolving `${...}` references and testing truthiness.
 */
export type ConditionEvaluator = (
  expression: string,
  ctx: ConditionContext,
) => boolean | Promise<boolean>;

export interface FlowStepResult {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  result?: TaskResult;
  skipped: boolean;
  duration: number;
  /** Number of attempts including the first try (≥1 when executed). */
  attempts?: number;
  /** Why the step was skipped: 'static' (skip list / task: None) or 'when' (condition false). */
  skipReason?: 'static' | 'when';
  /** True when the step failed but `ignore_failure` let the flow continue. */
  ignoredFailure?: boolean;
}

export interface HookError {
  phase: HookPhase;
  name: string;
  error: Error;
}

export interface RollbackResult {
  attempted: number;
  succeeded: number;
  errors: { taskName: string; error: Error }[];
}

export interface FlowRunResult {
  success: boolean;
  steps: FlowStepResult[];
  duration: number;
  error?: Error;
  /** Failures from hook steps (on_start / on_success / on_failure / finally). */
  hookErrors?: HookError[];
  /** Populated when rollback_on_failure ran. */
  rollback?: RollbackResult;
}

export interface PlanStep {
  stepNumber: number;
  type: 'task' | 'flow';
  name: string;
  skipped: boolean;
  options?: Record<string, unknown>;
  retries?: number;
  retryDelay?: number;
  retryOn?: string;
  /** Conditional execution — evaluated at run time, so plan reports it unresolved. */
  when?: string | boolean;
  /** Whether a failure of this step is tolerated. */
  ignore_failure?: boolean;
  /** For hook steps: the phase they belong to. Undefined for main steps. */
  phase?: HookPhase;
  /** Hierarchical id (e.g. "2/1") — only set when a plan expands nested flows. */
  path?: string;
  /** Nesting depth — 0 for top-level, increments per expanded nested flow. */
  depth?: number;
}

export interface FlowRunnerHooks {
  beforeRun?(flowName: string, plan: PlanStep[]): Promise<void>;
  afterRun?(result: FlowRunResult): Promise<void>;
  beforeStep?(step: PlanStep): Promise<void>;
  afterStep?(step: PlanStep, result: FlowStepResult): Promise<void>;
  onStepError?(step: PlanStep, error: Error, completed: FlowStepResult[]): Promise<void>;
}

/** Task-like object returned by a host-supplied nested agent factory. */
export interface NestedAgentTask {
  run(): Promise<TaskResult>;
}

/**
 * Creates the task used when an `AgentTask` invokes a configured sub-agent via
 * an `agent:` tool. The context and options have already been fully prepared by
 * `FlowRunner`; implementations should preserve them.
 */
export type NestedAgentTaskFactory = (
  ctx: ResolvedTaskContext & { readonly executionPhase: 'task' },
  options: AgentTaskOptions,
) => NestedAgentTask;

export interface FlowRunnerConfig {
  tasks: Record<string, TaskDefinition>;
  flows: Record<string, FlowDefinition>;
  registry: TaskRegistry;
  /** Host context; Flowkit supplies the per-invocation `executionPhase`. */
  context: TaskContextInput;
  hooks?: FlowRunnerHooks;
  logger?: Logger;
  /** Optional evaluator for string `when:` expressions. */
  conditionEvaluator?: ConditionEvaluator;
  /**
   * Host-supplied reference namespaces for `${ns.path}` interpolation in option
   * values, e.g. `{ project, org, env }`. `steps` and `error` are always built in.
   */
  references?: Record<string, unknown>;
  /**
   * Declarative agents. Each becomes runnable as a flow step (`task: <name>`)
   * and as another agent's `agent:` tool, and the runner wires `ctx.runFlow` /
   * `ctx.runAgent` so agents can call flows and sub-agents as tools.
   */
  agents?: Record<string, AgentDefinition>;
  /**
   * Optional factory for the task object used by configured sub-agents invoked
   * through `agent:` tools. Defaults to `(ctx, options) => new AgentTask(ctx,
   * options)`. Direct `AgentTask` construction and flow-step agent execution
   * continue to use the registry path.
   */
  nestedAgentTaskFactory?: NestedAgentTaskFactory;
}

// ---------------------------------------------------------------------------
// FlowRunner
// ---------------------------------------------------------------------------

export class FlowRunner {
  private logger: Logger;
  private tasks: Record<string, TaskDefinition>;
  private flows: Record<string, FlowDefinition>;
  private registry: TaskRegistry;
  private ctx: TaskContext;
  private hooks: FlowRunnerHooks;
  private conditionEvaluator?: ConditionEvaluator;
  private references?: Record<string, unknown>;
  private agents: Record<string, AgentDefinition>;
  private nestedAgentTaskFactory: NestedAgentTaskFactory;
  private runDepth = 0;
  /**
   * Reference scope outside any step: the host namespaces, no step results.
   * Every task runs under at least this, so `${project.x}` in a configured
   * default resolves the same whether the task runs as a step, as an agent
   * tool, from another task, or during rollback.
   */
  private baseReferences: ReferenceContext;

  constructor(config: FlowRunnerConfig) {
    this.logger = (config.logger ?? noopLogger).child({ component: 'flow-runner' });
    this.flows = config.flows;
    this.registry = config.registry;
    this.hooks = config.hooks ?? {};
    this.conditionEvaluator = config.conditionEvaluator;
    this.references = config.references;
    this.baseReferences = { steps: [], namespaces: this.references };
    this.agents = config.agents ?? {};
    this.nestedAgentTaskFactory =
      config.nestedAgentTaskFactory ?? ((ctx, options) => new AgentTask(ctx, options));

    // Compile each agent into a task definition so it is runnable as a flow
    // step (`task: <agentName>`) and as a task-backed tool. Explicit tasks of
    // the same name win.
    const agentTaskDefs: Record<string, TaskDefinition> = {};
    for (const [name, def] of Object.entries(this.agents)) {
      agentTaskDefs[name] = {
        class_path: 'agent',
        description: def.description,
        options: this.compileAgent(def) as Record<string, unknown>,
      };
    }
    this.tasks = { ...agentTaskDefs, ...config.tasks };

    // Ensure the `agent` class resolves without the consumer wiring it, unless
    // they already registered their own.
    if (Object.keys(this.agents).length > 0 && !this.registry.listRegistered().includes('agent')) {
      this.registry.register('agent', AgentTask as unknown as TaskConstructor);
    }

    // Expose the configured task definitions so tasks invoked as agent tools
    // inherit their class_path/options defaults (see AgentTask), and wire the
    // flow/agent tool dispatchers.
    // `executionPhase` is derived per invocation by `contextFor`, so a phase
    // present on `config.context` is deliberately ignored rather than merged:
    // the runner knows why each task is running and the host does not. This
    // seed value only covers reads of `this.ctx` outside a task invocation.
    this.ctx = {
      ...config.context,
      executionPhase: DEFAULT_EXECUTION_PHASE,
      registry: config.registry,
      taskDefinitions: this.tasks,
      taskReferenceContext: this.baseReferences,
      runFlow: (flowName, params) => this.runFlowTool(flowName, params),
      runAgent: (agentName, input, depth, ledger) =>
        this.runAgentTool(agentName, input, depth, ledger),
    };
  }

  /**
   * Context for work running under a given reference scope. The scope is
   * propagated to nested tasks (`taskReferenceContext`) and forwarded through
   * sub-agent dispatch, so a task invoked several agents deep resolves its
   * configured defaults exactly as it would as a top-level step.
   */
  private contextFor(
    references: ReferenceContext,
    executionPhase: ExecutionPhase = DEFAULT_EXECUTION_PHASE,
  ): TaskContext {
    return {
      ...this.ctx,
      taskReferenceContext: references,
      executionPhase,
      runAgent: (agentName, input, depth, ledger) =>
        this.runAgentTool(agentName, input, depth, ledger, references),
    };
  }

  /** Map an agent definition onto AgentTask options (everything but the prompt). */
  private compileAgent(def: AgentDefinition): Omit<AgentTaskOptions, 'prompt'> {
    const b = def.budget ?? {};
    const opts: Record<string, unknown> = {
      system: def.system,
      model: def.model,
      temperature: def.temperature,
      maxTokens: def.maxTokens,
      tools: def.tools,
      schema: def.schema,
      maxIterations: b.maxIterations,
      tokenBudget: b.tokenBudget,
      maxToolResultChars: b.maxToolResultChars,
      maxAgentResultChars: b.maxAgentResultChars,
      maxConcurrency: b.maxConcurrency,
      maxAgentDepth: b.maxAgentDepth,
      timeout: def.timeout,
      retries: def.retries,
    };
    for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
    return opts as Omit<AgentTaskOptions, 'prompt'>;
  }

  /** Run a configured flow as an agent tool, returning a compact step summary. */
  private async runFlowTool(
    flowName: string,
    params?: Record<string, unknown>,
  ): Promise<TaskResult> {
    if (!this.flows[flowName]) {
      return { success: false, error: new Error(`unknown flow "${flowName}"`) };
    }
    const res = await this.run({ flowName, params });
    const steps: Record<string, unknown> = {};
    for (const s of res.steps) {
      if (s.result?.data !== undefined) steps[s.name] = s.result.data;
    }
    return { success: res.success, error: res.error, data: { success: res.success, steps } };
  }

  /**
   * Run a configured agent as an agent tool (sub-agent), threading recursion
   * depth and the caller's token ledger so the sub-agent's spend charges the
   * same budget.
   */
  private async runAgentTool(
    agentName: string,
    input: Record<string, unknown>,
    depth: number,
    ledger?: TokenLedger,
    references: ReferenceContext = this.baseReferences,
  ): Promise<TaskResult> {
    const def = this.agents[agentName];
    if (!def) return { success: false, error: new Error(`unknown agent "${agentName}"`) };
    const prompt = typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input);
    // A compiled agent is configuration, so its `system` and friends interpolate
    // here exactly as they do when the same agent runs as a flow step. The
    // prompt is the caller's runtime input and stays literal.
    let compiled: Omit<AgentTaskOptions, 'prompt'>;
    try {
      compiled = resolveReferences(this.compileAgent(def), references);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
    const options = { ...compiled, prompt };
    // Carry the caller's reference scope down, so a task used as a tool inside
    // the sub-agent interpolates its configured defaults like anywhere else.
    const childCtx: ResolvedTaskContext & { readonly executionPhase: 'task' } = {
      ...this.contextFor(references),
      executionPhase: 'task',
      __agentDepth: depth,
      __tokenLedger: ledger,
    };
    try {
      return await this.nestedAgentTaskFactory(childCtx, options as AgentTaskOptions).run();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async run(options: FlowRunOptions): Promise<FlowRunResult> {
    return this.runWith(options, {});
  }

  /**
   * Run a single task by name, directly — the leaf unit of work, without a flow.
   * A flow is a composition of these; this is the same primitive each flow step
   * executes (see `executeTask`), so a task behaves identically whether it's run
   * on its own or as a step. `options` merge over the task's configured defaults.
   */
  async runTask(taskName: string, options: Record<string, unknown> = {}): Promise<TaskResult> {
    this.logger.info({ task: taskName }, `Running task ${taskName}`);
    // A direct invocation's `options` stand in for a step's configured options,
    // so they are interpolated here as a step's would be; `resolveTaskCall` then
    // layers them over the (also interpolated) configured defaults. A bad
    // reference is reported the way a step reports one, not thrown.
    const refs = this.baseReferences;
    let resolved: ResolvedTask;
    try {
      resolved = resolveTaskCall(taskName, this.tasks, resolveReferences(options, refs), refs);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
    return this.executeTask(resolved.classPath, resolved.options, refs);
  }

  /**
   * Instantiate and run a task with fully-resolved options (the shared leaf).
   *
   * Never throws: a failure to load or construct the class is reported as a
   * failed `TaskResult`, the same shape `BaseTask.run` guarantees for a failure
   * inside the task. Every path into a task goes through here, so running one
   * as a step, directly, as a tool, or during rollback all report failure
   * identically — and a step's `retries` cover construction, not just execution.
   * Task-to-task calls derive their equivalent context in `BaseTask.resolve`.
   */
  private async executeTask(
    classPath: string,
    options: Record<string, unknown>,
    references: ReferenceContext,
    executionPhase: ExecutionPhase = DEFAULT_EXECUTION_PHASE,
  ): Promise<TaskResult> {
    const taskCtx = this.contextFor(references, executionPhase);
    try {
      const task = await this.registry.create(classPath, taskCtx, options);
      return task.run();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async runWith(
    options: FlowRunOptions,
    parentOptions: ParentOptions,
  ): Promise<FlowRunResult> {
    this.runDepth++;
    const isTopLevel = this.runDepth === 1;
    try {
      return await this.executeFlow(options, isTopLevel, parentOptions);
    } finally {
      this.runDepth--;
    }
  }

  resolveExecutionPlan(flow: FlowDefinition, skipSet: Set<string>): PlanStep[] {
    const sortedKeys = Object.keys(flow.steps)
      .map(Number)
      .sort((a, b) => a - b);

    return sortedKeys.map((key) => this.planStepFromDef(flow.steps[String(key)]!, key, skipSet));
  }

  private planStepFromDef(step: FlowStep, stepNumber: number, skipSet: Set<string>): PlanStep {
    if (step.task === 'None') {
      return { stepNumber, type: 'task', name: 'None', skipped: true };
    }
    const name = (step.task ?? step.flow)!;
    const type: 'task' | 'flow' = step.task ? 'task' : 'flow';
    return {
      stepNumber,
      type,
      name,
      skipped: skipSet.has(name) || skipSet.has(String(stepNumber)),
      options: step.options as Record<string, unknown> | undefined,
      retries: step.retries,
      retryDelay: step.retryDelay,
      retryOn: step.retryOn,
      when: step.when,
      ignore_failure: step.ignore_failure,
    };
  }

  private planHookSteps(
    hookSteps: FlowStep[] | undefined,
    phase: HookPhase,
    skipSet: Set<string>,
    baseStepNumber: number,
  ): PlanStep[] {
    if (!hookSteps || hookSteps.length === 0) return [];
    return hookSteps.map((s, i) => ({
      ...this.planStepFromDef(s, baseStepNumber + i, skipSet),
      phase,
    }));
  }

  /**
   * Merge an enclosing flow step's per-task override map onto inherited parent
   * options. Inner (closer) overrides win over outer for the same task+key.
   */
  private mergeParentOptions(
    base: ParentOptions,
    overrideMap: Record<string, unknown> | undefined,
  ): ParentOptions {
    if (!overrideMap) return base;
    const out: ParentOptions = { ...base };
    for (const [name, opts] of Object.entries(overrideMap)) {
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        out[name] = { ...(base[name] ?? {}), ...(opts as Record<string, unknown>) };
      }
    }
    return out;
  }

  /** Recursively expand a plan step's nested flow into its child steps. */
  private expandPlanStep(
    planStep: PlanStep,
    parentOptions: ParentOptions,
    pathPrefix: string,
    depth: number,
    ancestors: Set<string>,
    skipSet: Set<string>,
  ): PlanStep[] {
    const self: PlanStep = { ...planStep, path: pathPrefix, depth };
    if (planStep.type !== 'flow' || planStep.skipped || ancestors.has(planStep.name)) {
      return [self];
    }
    const childFlow = this.flows[planStep.name];
    if (!childFlow) return [self];

    const childParentOptions = this.mergeParentOptions(parentOptions, planStep.options);
    const nextAncestors = new Set(ancestors).add(planStep.name);
    const childPlan = this.resolveExecutionPlan(childFlow, skipSet);
    const children = childPlan.flatMap((cs) =>
      this.expandPlanStep(
        cs,
        childParentOptions,
        `${pathPrefix}/${cs.stepNumber}`,
        depth + 1,
        nextAncestors,
        skipSet,
      ),
    );
    return [self, ...children];
  }

  /**
   * Evaluate a step's `when:` to a boolean. Undefined `when` always runs.
   *
   * `executionPhase` is the phase the step's own task will observe. It is
   * threaded in rather than read off `this.ctx`, whose phase is only the
   * constructor seed: a `finally` hook gating on `context.executionPhase`
   * would otherwise be told `'task'` and run when it meant to skip.
   */
  private async evaluateWhen(
    when: string | boolean | undefined,
    completedSteps: FlowStepResult[],
    params: Record<string, unknown> | undefined,
    executionPhase: ExecutionPhase,
    errorCtx?: { error: Error; step?: string },
  ): Promise<boolean> {
    if (when === undefined) return true;
    if (typeof when === 'boolean') return when;

    const error = errorCtx
      ? {
          message: errorCtx.error.message,
          name: errorCtx.error.name,
          stack: errorCtx.error.stack,
          step: errorCtx.step,
        }
      : undefined;

    if (this.conditionEvaluator) {
      return await this.conditionEvaluator(when, {
        steps: completedSteps,
        params,
        context: executionPhase === this.ctx.executionPhase ? this.ctx : { ...this.ctx, executionPhase },
        error,
      });
    }

    // Built-in fallback: resolve ${...} references, then test truthiness.
    const resolved = resolveReferences(when as unknown, {
      steps: completedSteps,
      namespaces: this.references,
      error,
    });
    return truthy(resolved);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeFlow(
    options: FlowRunOptions,
    isTopLevel: boolean,
    parentOptions: ParentOptions,
  ): Promise<FlowRunResult> {
    const startTime = Date.now();
    const skipSet = new Set(options.skip ?? []);
    const completedSteps: FlowStepResult[] = [];
    const hookErrors: HookError[] = [];
    const rollbackRecords: { taskName: string; payload: Record<string, unknown> }[] = [];

    const flow = this.flows[options.flowName];
    if (!flow) {
      throw new Error(`Flow "${options.flowName}" not found in configuration`);
    }

    const rollbackEnabled = options.rollback_on_failure ?? flow.rollback_on_failure ?? false;

    const executionPlan = this.resolveExecutionPlan(flow, skipSet);

    // Plan mode — dump all phases for visibility, nothing runs.
    if (options.plan) {
      const mainPlan = options.expandNestedFlows
        ? executionPlan.flatMap((s) =>
            this.expandPlanStep(
              s,
              parentOptions,
              String(s.stepNumber),
              0,
              new Set([options.flowName]),
              skipSet,
            ),
          )
        : executionPlan;
      const fullPlan: PlanStep[] = [
        ...this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000),
        ...mainPlan,
        ...this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000),
        ...this.planHookSteps(flow.on_failure, 'on_failure', skipSet, 20_000),
        ...this.planHookSteps(flow.finally, 'finally', skipSet, 30_000),
      ];
      return {
        success: true,
        steps: fullPlan.map((s) => ({
          stepNumber: s.stepNumber,
          type: s.type,
          name: s.name,
          skipped: s.skipped,
          duration: 0,
          ...(s.path !== undefined ? { path: s.path, depth: s.depth } : {}),
        })) as unknown as FlowStepResult[],
        duration: 0,
      };
    }

    if (isTopLevel) {
      await this.hooks.beforeRun?.(options.flowName, executionPlan);
    }

    let flowError: Error | undefined;
    let flowErrorStepName: string | undefined;

    // ---- on_start ----
    {
      const startPlan = this.planHookSteps(flow.on_start, 'on_start', skipSet, -3000);
      for (const hookStep of startPlan) {
        const ok = await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          undefined,
          hookErrors,
        );
        if (!ok) {
          flowError = hookErrors[hookErrors.length - 1]?.error;
          flowErrorStepName = hookStep.name;
          break;
        }
      }
    }

    // ---- main steps ----
    if (!flowError) {
      for (const planStep of executionPlan) {
        // Resolve conditional execution (`when:`) at run time.
        let conditionMet = true;
        let conditionError: Error | undefined;
        if (!planStep.skipped && planStep.when !== undefined) {
          try {
            conditionMet = await this.evaluateWhen(
              planStep.when,
              completedSteps,
              options.params,
              planStep.phase ?? DEFAULT_EXECUTION_PHASE,
            );
          } catch (err) {
            conditionError = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (conditionError) {
          // A condition that throws is treated like a step failure.
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: false,
            duration: 0,
            result: { success: false, error: conditionError },
          };
          completedSteps.push(sr);
          await this.hooks.afterStep?.(planStep, sr);
          if (planStep.ignore_failure) {
            sr.ignoredFailure = true;
            continue;
          }
          flowError = conditionError;
          flowErrorStepName = planStep.name;
          await this.hooks.onStepError?.(planStep, conditionError, completedSteps);
          break;
        }

        if (planStep.skipped || !conditionMet) {
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: true,
            duration: 0,
            skipReason: planStep.skipped ? 'static' : 'when',
          };
          completedSteps.push(sr);
          await this.hooks.afterStep?.(planStep, sr);
          continue;
        }

        await this.hooks.beforeStep?.(planStep);
        const stepStart = Date.now();

        try {
          let stepResult: FlowStepResult;

          if (planStep.type === 'task') {
            const { result: taskResult, attempts } = await this.executeTaskStepWithRetry(
              planStep,
              options.params,
              completedSteps,
              parentOptions,
            );
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'task',
              name: planStep.name,
              result: taskResult,
              skipped: false,
              duration: Date.now() - stepStart,
              attempts,
            };
            if (taskResult.success && taskResult.rollback) {
              rollbackRecords.push({
                taskName: taskResult.rollback.taskName,
                payload: taskResult.rollback.payload,
              });
            }
          } else {
            const childParentOptions = this.mergeParentOptions(parentOptions, planStep.options);
            const nestedResult = await this.runWith(
              { ...options, flowName: planStep.name, plan: false },
              childParentOptions,
            );
            stepResult = {
              stepNumber: planStep.stepNumber,
              type: 'flow',
              name: planStep.name,
              result: {
                success: nestedResult.success,
                data: { stepCount: nestedResult.steps.length },
                error: nestedResult.success ? undefined : nestedResult.error,
              },
              skipped: false,
              duration: Date.now() - stepStart,
            };
            // Bubble nested rollback records up so the parent can invoke them.
            for (const s of nestedResult.steps) {
              if (s.result?.success && s.result?.rollback) {
                rollbackRecords.push({
                  taskName: s.result.rollback.taskName,
                  payload: s.result.rollback.payload,
                });
              }
            }
          }

          completedSteps.push(stepResult);
          await this.hooks.afterStep?.(planStep, stepResult);

          if (!stepResult.result?.success) {
            if (planStep.ignore_failure) {
              stepResult.ignoredFailure = true;
              this.logger.info(
                { step: planStep.stepNumber, task: planStep.name },
                `Step ${planStep.name} failed but ignore_failure is set; continuing`,
              );
              continue;
            }
            flowError =
              stepResult.result?.error ?? new Error(`Step ${planStep.name} failed`);
            flowErrorStepName = planStep.name;
            await this.hooks.onStepError?.(planStep, flowError, completedSteps);
            break;
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const sr: FlowStepResult = {
            stepNumber: planStep.stepNumber,
            type: planStep.type,
            name: planStep.name,
            skipped: false,
            duration: Date.now() - stepStart,
            result: { success: false, error: err },
          };
          completedSteps.push(sr);
          if (planStep.ignore_failure) {
            sr.ignoredFailure = true;
            await this.hooks.afterStep?.(planStep, sr);
            this.logger.info(
              { step: planStep.stepNumber, task: planStep.name },
              `Step ${planStep.name} threw but ignore_failure is set; continuing`,
            );
            continue;
          }
          flowError = err;
          flowErrorStepName = planStep.name;
          await this.hooks.onStepError?.(planStep, err, completedSteps);
          break;
        }
      }
    }

    // ---- on_success or on_failure ----
    if (flowError) {
      const failPlan = this.planHookSteps(flow.on_failure, 'on_failure', skipSet, 20_000);
      for (const hookStep of failPlan) {
        await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          { error: flowError, step: flowErrorStepName },
          hookErrors,
        );
      }
    } else {
      const successPlan = this.planHookSteps(flow.on_success, 'on_success', skipSet, 10_000);
      for (const hookStep of successPlan) {
        await this.runHookStep(hookStep, options, completedSteps, parentOptions, undefined, hookErrors);
      }
    }

    // ---- rollback ----
    let rollbackResult: RollbackResult | undefined;
    if (flowError && rollbackEnabled && rollbackRecords.length > 0) {
      rollbackResult = await this.performRollback(rollbackRecords);
    }

    // ---- finally ----
    {
      const finallyPlan = this.planHookSteps(flow.finally, 'finally', skipSet, 30_000);
      for (const hookStep of finallyPlan) {
        await this.runHookStep(
          hookStep,
          options,
          completedSteps,
          parentOptions,
          flowError ? { error: flowError, step: flowErrorStepName } : undefined,
          hookErrors,
        );
      }
    }

    const result: FlowRunResult = {
      success: !flowError,
      steps: completedSteps,
      duration: Date.now() - startTime,
      error: flowError,
      hookErrors: hookErrors.length > 0 ? hookErrors : undefined,
      rollback: rollbackResult,
    };

    if (isTopLevel) {
      await this.hooks.afterRun?.(result);
    }

    return result;
  }

  private async runHookStep(
    hookStep: PlanStep,
    options: FlowRunOptions,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx: { error: Error; step?: string } | undefined,
    hookErrors: HookError[],
  ): Promise<boolean> {
    if (hookStep.skipped) return true;

    // Hook steps honor `when:` too — a falsy condition skips them silently.
    if (hookStep.when !== undefined) {
      try {
        const ok = await this.evaluateWhen(
          hookStep.when,
          completedSteps,
          options.params,
          hookStep.phase ?? DEFAULT_EXECUTION_PHASE,
          errorCtx,
        );
        if (!ok) return true;
      } catch (err) {
        hookErrors.push({
          phase: hookStep.phase!,
          name: hookStep.name,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return false;
      }
    }

    try {
      if (hookStep.type === 'flow') {
        const childParentOptions = this.mergeParentOptions(parentOptions, hookStep.options);
        const nested = await this.runWith(
          { ...options, flowName: hookStep.name, plan: false },
          childParentOptions,
        );
        if (!nested.success) {
          hookErrors.push({
            phase: hookStep.phase!,
            name: hookStep.name,
            error: nested.error ?? new Error(`Nested flow ${hookStep.name} failed`),
          });
          return false;
        }
        return true;
      }

      const { result } = await this.executeTaskStepWithRetry(
        hookStep,
        options.params,
        completedSteps,
        parentOptions,
        errorCtx,
      );
      if (!result.success) {
        hookErrors.push({
          phase: hookStep.phase!,
          name: hookStep.name,
          error: result.error ?? new Error(`Hook ${hookStep.phase} step ${hookStep.name} failed`),
        });
        return false;
      }
      return true;
    } catch (err) {
      hookErrors.push({
        phase: hookStep.phase!,
        name: hookStep.name,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
  }

  private async executeTaskStepWithRetry(
    step: PlanStep,
    flowParams: Record<string, unknown> | undefined,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx?: { error: Error; step?: string },
  ): Promise<{ result: TaskResult; attempts: number }> {
    const maxAttempts = Math.max(1, 1 + (step.retries ?? 0));
    const delayMs = step.retryDelay ?? 0;
    const retryOn = step.retryOn;

    let lastResult: TaskResult = { success: false, error: new Error('no attempts executed') };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.executeTaskStep(
        step,
        flowParams,
        completedSteps,
        parentOptions,
        errorCtx,
      );
      if (lastResult.success) return { result: lastResult, attempts: attempt };

      const errMsg = lastResult.error?.message ?? '';
      const retryMatches = retryOn == null || errMsg.includes(retryOn);

      if (attempt < maxAttempts && retryMatches) {
        if (delayMs > 0) await sleep(delayMs);
        this.logger.info(
          { step: step.stepNumber, task: step.name, attempt, nextAttempt: attempt + 1 },
          `Retrying step ${step.name}`,
        );
        continue;
      }
      break;
    }

    return { result: lastResult, attempts: maxAttempts };
  }

  private async executeTaskStep(
    step: PlanStep,
    flowParams: Record<string, unknown> | undefined,
    completedSteps: FlowStepResult[],
    parentOptions: ParentOptions,
    errorCtx?: { error: Error; step?: string },
  ): Promise<TaskResult> {
    const taskDef = resolveTaskDefinition(step.name, this.tasks);
    // Precedence (low → high): task default → enclosing-flow override → step inline → runtime params.
    // Every layer here is configuration, so the merge is interpolated as a whole.
    const rawOptions = {
      ...taskDef.options,
      ...(parentOptions[step.name] ?? {}),
      ...step.options,
      ...flowParams,
    };

    const refCtx: ReferenceContext = {
      steps: completedSteps,
      namespaces: this.references,
      error: errorCtx
        ? {
            message: errorCtx.error.message,
            name: errorCtx.error.name,
            stack: errorCtx.error.stack,
            step: errorCtx.step,
          }
        : undefined,
    };

    let mergedOptions: Record<string, unknown>;
    try {
      mergedOptions = resolveReferences(rawOptions, refCtx);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    this.logger.info(
      { step: step.stepNumber, task: step.name, type: step.type },
      `Executing step ${step.stepNumber}: ${step.name}`,
    );

    return this.executeTask(
      taskDef.classPath,
      mergedOptions,
      refCtx,
      step.phase ?? DEFAULT_EXECUTION_PHASE,
    );
  }

  private async performRollback(
    records: { taskName: string; payload: Record<string, unknown> }[],
  ): Promise<RollbackResult> {
    const result: RollbackResult = { attempted: 0, succeeded: 0, errors: [] };

    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]!;
      result.attempted++;
      try {
        // A rollback payload is runtime data the task recorded, not
        // configuration: `resolveTaskCall` interpolates the inverse task's
        // configured defaults and merges the payload over them verbatim, so a
        // `${...}` captured in recorded data is neither substituted nor thrown
        // on — which the catch below would turn into a silently failed rollback.
        const resolved = resolveTaskCall(
          rec.taskName,
          this.tasks,
          rec.payload,
          this.baseReferences,
        );
        const r = await this.executeTask(
          resolved.classPath,
          resolved.options,
          this.baseReferences,
          'rollback',
        );
        if (r.success) {
          result.succeeded++;
        } else {
          result.errors.push({
            taskName: rec.taskName,
            error: r.error ?? new Error(`Rollback ${rec.taskName} returned failure`),
          });
        }
      } catch (err) {
        result.errors.push({
          taskName: rec.taskName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    return result;
  }
}

/** Truthiness of a resolved `when:` value, with string special-cases. */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'null' || s === 'undefined');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
