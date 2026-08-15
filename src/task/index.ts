export { BaseTask, DEFAULT_EXECUTION_PHASE, resolveTaskContext } from './base-task.js';
export type {
  TaskContext,
  TaskContextInput,
  ResolvedTaskContext,
  ExecutionPhase,
  TaskResult,
  RollbackRecord,
} from './base-task.js';
export { ShellTask } from './shell-task.js';
export type { ShellTaskOptions } from './shell-task.js';
export { TaskRegistry } from './registry.js';
export type { TaskConstructor } from './registry.js';

// Agent / LLM
export { AgentPromptTask } from './agent-prompt-task.js';
export type { AgentPromptOptions } from './agent-prompt-task.js';
export { AgentTask } from './agent-task.js';
export type { AgentTaskOptions, AgentToolSpec } from './agent-task.js';
export {
  runCompletion,
  pickRunOptions,
  LLMAbortError,
  LLMTimeoutError,
  StructuredOutputError,
} from './llm-runner.js';
export type { LLMRunOptions, LLMRunResult, AgentRunFields, AgentRetryOptions } from './llm-runner.js';
export { validateJson, formatErrors } from './json-schema.js';
export type { ValidationError, ValidationResult } from './json-schema.js';
export { redact, truncate, preview } from './redact.js';
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
} from './llm-provider.js';
