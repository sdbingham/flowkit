import type { ShellTaskOptions as RootShellTaskOptions } from '@db-lyon/flowkit';
import type { ShellTaskOptions as TaskShellTaskOptions } from '@db-lyon/flowkit/task';
import type {
  AgentPromptOptions as RootAgentPromptOptions,
  AgentRetryOptions as RootAgentRetryOptions,
  AgentRunFields as RootAgentRunFields,
  AgentTaskOptions as RootAgentTaskOptions,
} from '@db-lyon/flowkit';
import type {
  AgentPromptOptions as TaskAgentPromptOptions,
  AgentRetryOptions as TaskAgentRetryOptions,
  AgentRunFields as TaskAgentRunFields,
  AgentTaskOptions as TaskAgentTaskOptions,
} from '@db-lyon/flowkit/task';
import type { Guard as RootGuard, GuardContext } from '@db-lyon/flowkit';
import type { Guard as GuardGuard } from '@db-lyon/flowkit/guard';
import { GuardRegistry, runGuarded, guardContextBase } from '@db-lyon/flowkit/guard';
import { GuardRegistry as RootGuardRegistry } from '@db-lyon/flowkit';
import { ShellTask as RootShellTask } from '@db-lyon/flowkit';
import { LLMAbortError as RootLLMAbortError } from '@db-lyon/flowkit';
import { ShellTask as TaskShellTask } from '@db-lyon/flowkit/task';
import { LLMAbortError as TaskLLMAbortError } from '@db-lyon/flowkit/task';
import { TaskRegistry as RootTaskRegistry } from '@db-lyon/flowkit';
import { TaskRegistry as TaskTaskRegistry } from '@db-lyon/flowkit/task';
import type { FlowRunnerConfig as RootFlowRunnerConfig } from '@db-lyon/flowkit';
import type {
  FlowRunnerConfig as FlowFlowRunnerConfig,
  NestedAgentTask as FlowNestedAgentTask,
  NestedAgentTaskFactory as FlowNestedAgentTaskFactory,
} from '@db-lyon/flowkit/flow';
import type {
  NestedAgentTask as RootNestedAgentTask,
  NestedAgentTaskFactory as RootNestedAgentTaskFactory,
} from '@db-lyon/flowkit';
import type {
  ExecutionPhase as RootExecutionPhase,
  ResolvedTaskContext as RootResolvedTaskContext,
  TaskConstructor as RootTaskConstructor,
  TaskContext as RootTaskContext,
  TaskContextInput as RootTaskContextInput,
  TaskResult as RootTaskResult,
} from '@db-lyon/flowkit';
import type {
  ExecutionPhase as TaskExecutionPhase,
  ResolvedTaskContext as TaskResolvedTaskContext,
  TaskConstructor as TaskTaskConstructor,
  TaskContext as TaskTaskContext,
  TaskContextInput as TaskTaskContextInput,
} from '@db-lyon/flowkit/task';
import { BaseTask as RootBaseTask } from '@db-lyon/flowkit';

const signal = new AbortController().signal;
const rootOptions: RootShellTaskOptions = { command: 'echo root', signal };
const taskOptions: TaskShellTaskOptions = { command: 'echo task', signal };
const retryOn = (err: Error) => err.name === 'retryable';
const rootAgentTaskOptions: RootAgentTaskOptions = { prompt: 'root', retryOn };
const rootAgentPromptOptions: RootAgentPromptOptions = { prompt: 'root', retryOn };
const taskAgentTaskOptions: TaskAgentTaskOptions = { prompt: 'task', retryOn };
const taskAgentPromptOptions: TaskAgentPromptOptions = { prompt: 'task', retryOn };
const rootAgentRetryOptions: RootAgentRetryOptions = { retryOn };
const taskAgentRetryOptions: TaskAgentRetryOptions = rootAgentRetryOptions;
const rootAgentRunFields: RootAgentRunFields = { retries: 2 };
const taskAgentRunFields: TaskAgentRunFields = rootAgentRunFields;
// @ts-expect-error retryOn is host-only and must not become part of YAML-safe AgentRunFields.
const invalidAgentRunFields: RootAgentRunFields = { retryOn };
const rootTask = new RootShellTask({}, rootOptions);
const taskTask = new TaskShellTask({}, taskOptions);
const rootAbortError: Error = new RootLLMAbortError();
const taskAbortError: Error = new TaskLLMAbortError();
const rootCreatedTask = new RootTaskRegistry().create('root-task', {}, {});
const taskCreatedTask = new TaskTaskRegistry().create('task-task', {}, {});
const phases: RootExecutionPhase[] = [
  'task',
  'on_start',
  'on_success',
  'on_failure',
  'finally',
  'rollback',
];
const taskPhase: TaskExecutionPhase = 'task';
const rootInput: RootTaskContextInput = {};
const taskInput: TaskTaskContextInput = {};
const rootSignalContext: RootTaskContext = { signal };
const taskSignalContext: TaskTaskContext = { signal };

declare const rootConstructor: RootTaskConstructor;
declare const taskConstructor: TaskTaskConstructor;
const rootConstructedTask = new rootConstructor({ executionPhase: 'task' }, {});
const taskConstructedTask = new taskConstructor({ executionPhase: 'task' }, {});

class ExplicitContextTask extends RootBaseTask {
  constructor(ctx: RootTaskContext, options: Record<string, unknown>) {
    super(ctx, options);
  }

  get taskName(): string {
    return 'explicit-context';
  }

  async execute(): Promise<RootTaskResult> {
    return { success: true };
  }
}

const explicitContextRegistry = new RootTaskRegistry().register(
  'explicit-context',
  ExplicitContextTask,
);
const explicitTaskContextRegistry = new TaskTaskRegistry().register(
  'explicit-context',
  ExplicitContextTask,
);

// A running task observes a resolved phase: Flowkit supplied it at construction.
declare const rootContext: RootResolvedTaskContext;
declare const taskContext: TaskResolvedTaskContext;
const rootContextPhase: RootExecutionPhase = rootContext.executionPhase;
const taskContextPhase: TaskExecutionPhase = taskContext.executionPhase;

// A host builds and extends `TaskContext` without ever naming a phase, and an
// interface extending it stays constructible. This is the ue-mcp `FlowContext`
// shape; requiring the phase here would break every downstream context type.
interface HostFlowContext extends RootTaskContext {
  bridge: { call(method: string): Promise<unknown> };
}
const hostContext: HostFlowContext = { bridge: { call: async () => null } };
const hostTaskContext: TaskTaskContext = {};
const rootRunnerContext: RootFlowRunnerConfig['context'] = {};
const flowRunnerContext: FlowFlowRunnerConfig['context'] = {};
const rootNestedAgentTaskFactory: RootNestedAgentTaskFactory = (ctx, options) => ({
  run: async () => {
    const nestedPhase: 'task' = ctx.executionPhase;
    return { success: true, data: { phase: nestedPhase, prompt: options.prompt } };
  },
});
const flowNestedAgentTaskFactory: FlowNestedAgentTaskFactory = rootNestedAgentTaskFactory;
const rootNestedAgentTask: RootNestedAgentTask = { run: async () => ({ success: true }) };
const flowNestedAgentTask: FlowNestedAgentTask = rootNestedAgentTask;
const invalidNestedAgentTask: RootNestedAgentTask = {
  // @ts-expect-error A nested task must resolve to Flowkit's TaskResult shape.
  run: async () => 'not a task result',
};
const rootRunnerWithNestedFactory: RootFlowRunnerConfig = {
  tasks: {},
  flows: {},
  registry: new RootTaskRegistry(),
  context: {},
  nestedAgentTaskFactory: rootNestedAgentTaskFactory,
};
const flowRunnerWithNestedFactory: FlowFlowRunnerConfig = {
  tasks: {},
  flows: {},
  registry: new RootTaskRegistry(),
  context: {},
  nestedAgentTaskFactory: flowNestedAgentTaskFactory,
};

// @ts-expect-error lifecycle values are a closed public union.
const invalidPhase: RootExecutionPhase = 'cleanup';

// The lifecycle value is observable but runner-owned and read-only.
// @ts-expect-error executionPhase cannot be mutated by a task.
rootContext.executionPhase = 'rollback';
// @ts-expect-error executionPhase cannot be mutated through the task subpath either.
taskContext.executionPhase = 'finally';

// The root and the ./guard subpath must describe the same guard, so a host can
// import from either without the two drifting into incompatible shapes.
const guard: RootGuard<GuardContext, string> = { name: 'x', before: async () => {} };
const sameGuard: GuardGuard<GuardContext, string> = guard;

const registry: RootGuardRegistry<GuardContext, string> = new GuardRegistry<
  GuardContext,
  string
>().register(sameGuard);

const run = runGuarded(guardContextBase(), registry, async () => 'ok');

void rootOptions;
void taskOptions;
void rootAgentTaskOptions;
void rootAgentPromptOptions;
void taskAgentTaskOptions;
void taskAgentPromptOptions;
void rootAgentRetryOptions;
void taskAgentRetryOptions;
void rootAgentRunFields;
void taskAgentRunFields;
void invalidAgentRunFields;
void run;
void rootTask;
void taskTask;
void rootAbortError;
void taskAbortError;
void rootCreatedTask;
void taskCreatedTask;
void phases;
void taskPhase;
void rootInput;
void taskInput;
void rootSignalContext;
void taskSignalContext;
void rootConstructedTask;
void taskConstructedTask;
void explicitContextRegistry;
void explicitTaskContextRegistry;
void rootContextPhase;
void taskContextPhase;
void hostContext;
void hostTaskContext;
void rootRunnerContext;
void flowRunnerContext;
void rootNestedAgentTaskFactory;
void flowNestedAgentTaskFactory;
void rootNestedAgentTask;
void flowNestedAgentTask;
void invalidNestedAgentTask;
void rootRunnerWithNestedFactory;
void flowRunnerWithNestedFactory;
void invalidPhase;
