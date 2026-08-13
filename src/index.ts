// Config
export { deepMerge } from './config/deep-merge.js';
export {
  TaskOptionsSchema,
  TaskDefinitionSchema,
  FlowStepSchema,
  FlowDefinitionSchema,
  AgentToolSchema,
  AgentBudgetSchema,
  AgentDefinitionSchema,
  EngineConfigSchema,
} from './config/schema.js';
export type {
  TaskOptions,
  TaskDefinition,
  FlowStep,
  FlowDefinition,
  AgentTool,
  AgentBudget,
  AgentDefinition,
  EngineConfig,
} from './config/schema.js';
export { loadConfig, loadRawYaml, findConfigFile } from './config/loader.js';
export type { LoadConfigOptions, LoadedConfig } from './config/loader.js';

// Task
export { BaseTask, DEFAULT_EXECUTION_PHASE, resolveTaskContext } from './task/base-task.js';
export type {
  TaskContext,
  TaskContextInput,
  ResolvedTaskContext,
  ExecutionPhase,
  TaskResult,
  RollbackRecord,
} from './task/base-task.js';
export { ShellTask } from './task/shell-task.js';
export type { ShellTaskOptions } from './task/shell-task.js';
export { TaskRegistry } from './task/registry.js';
export type { TaskConstructor } from './task/registry.js';
export { AgentPromptTask } from './task/agent-prompt-task.js';
export type { AgentPromptOptions } from './task/agent-prompt-task.js';
export { AgentTask } from './task/agent-task.js';
export type { AgentTaskOptions, AgentToolSpec } from './task/agent-task.js';
export {
  runCompletion,
  pickRunOptions,
  LLMTimeoutError,
  StructuredOutputError,
} from './task/llm-runner.js';
export type { LLMRunOptions, LLMRunResult, AgentRunFields, AgentRetryOptions } from './task/llm-runner.js';
export { validateJson, formatErrors } from './task/json-schema.js';
export type { ValidationError, ValidationResult } from './task/json-schema.js';
export { mapLimit } from './task/concurrency.js';
export {
  createLedger,
  chargeLedger,
  ledgerExhausted,
  exhaustedLimit,
} from './task/token-ledger.js';
export type { TokenLedger } from './task/token-ledger.js';
export { redact, truncate, preview } from './task/redact.js';
export type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
  LLMRole,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolChoice,
  LLMToolHandler,
} from './task/llm-provider.js';

// Flow
export { FlowRunner } from './flow/runner.js';
export type {
  FlowRunOptions,
  FlowStepResult,
  FlowRunResult,
  FlowRunnerHooks,
  FlowRunnerConfig,
  NestedAgentTask,
  NestedAgentTaskFactory,
  PlanStep,
  HookPhase,
  HookError,
  RollbackResult,
} from './flow/runner.js';
// Guard — before/after pipeline around a host operation
export { GuardRegistry } from './guard/registry.js';
export { runGuarded } from './guard/pipeline.js';
export { discoverTaskGuards } from './guard/task-guards.js';
export type {
  DiscoverTaskGuardsOptions,
  GuardScope,
  GuardTaskFailure,
} from './guard/task-guards.js';
export { guardContextBase, lazy } from './guard/types.js';
export type { Guard, GuardContext } from './guard/types.js';

// References — shared by the task and flow layers
export { resolveReferences } from './references.js';
export type { ReferenceableStep, ReferenceContext } from './references.js';

// DAG
export {
  topologicalSort,
  CircularDependencyError,
  MissingDependencyError,
} from './dag/resolver.js';
export type { DagNode } from './dag/resolver.js';

// Logger
export type { Logger } from './logger.js';
export { noopLogger } from './logger.js';
