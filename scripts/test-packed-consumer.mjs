#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const workspace = mkdtempSync(join(tmpdir(), 'flowkit-packed-consumer-'));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function runNpm(args, cwd) {
  if (!npmCli) throw new Error('npm_execpath is required to run the packed-consumer check.');
  return run(process.execPath, [npmCli, ...args], cwd);
}

try {
  const pack = JSON.parse(runNpm(['pack', '--pack-destination', workspace, '--json'], root));
  const tarball = join(workspace, pack[0].filename);
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'flowkit-packed-consumer-check', private: true, type: 'module' }),
  );
  writeFileSync(
    join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true }, include: ['index.ts'] }),
  );
  writeFileSync(
    join(workspace, 'index.ts'),
    `import { AgentTask, FlowRunner, TaskRegistry, type AgentPromptOptions, type AgentRetryOptions, type AgentRunFields, type AgentTaskOptions, type NestedAgentTaskFactory } from '@db-lyon/flowkit';
import type { NestedAgentTaskFactory as FlowFactory } from '@db-lyon/flowkit/flow';
import type { AgentPromptOptions as TaskAgentPromptOptions, AgentRetryOptions as TaskAgentRetryOptions, AgentRunFields as TaskAgentRunFields, AgentTaskOptions as TaskAgentTaskOptions } from '@db-lyon/flowkit/task';
const retryOn = (err: Error) => err.name === 'non-retryable';
const agentOptions: AgentTaskOptions = { prompt: 'go', retryOn };
const promptOptions: AgentPromptOptions = { prompt: 'go', retryOn };
const taskAgentOptions: TaskAgentTaskOptions = agentOptions;
const taskPromptOptions: TaskAgentPromptOptions = promptOptions;
const retryOptions: AgentRetryOptions = { retryOn };
const taskRetryOptions: TaskAgentRetryOptions = retryOptions;
const runFields: AgentRunFields = { retries: 2 };
const taskRunFields: TaskAgentRunFields = runFields;
// @ts-expect-error retryOn is host-only, not YAML-safe AgentRunFields.
const invalidRunFields: AgentRunFields = { retryOn };
void taskAgentOptions; void taskPromptOptions; void taskRetryOptions; void taskRunFields; void invalidRunFields;
const factory: NestedAgentTaskFactory = (ctx, options) => {
  const phase: 'task' = ctx.executionPhase;
  void phase;
  return new AgentTask(ctx, options);
};
const flowFactory: FlowFactory = factory;
new FlowRunner({ tasks: {}, flows: {}, agents: {}, registry: new TaskRegistry(), context: {}, nestedAgentTaskFactory: flowFactory });
`,
  );
  writeFileSync(
    join(workspace, 'runtime.mjs'),
    `import { AgentTask, FlowRunner, TaskRegistry } from '@db-lyon/flowkit';
let turns = 0;
let workerAttempts = 0;
let factoryPhase;
const provider = { async complete(request) {
  if (request.system === 'WORKER') { workerAttempts += 1; throw new Error('non-retryable'); }
  turns += 1;
  return turns === 1
    ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'go' } }] }
    : { text: 'coord-done', finishReason: 'stop' };
} };
const runner = new FlowRunner({
  tasks: {},
  flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } },
  agents: { coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 1000 } }, worker: { system: 'WORKER' } },
  registry: new TaskRegistry(),
  context: { llm: provider },
  nestedAgentTaskFactory: (ctx, options) => { factoryPhase = ctx.executionPhase; return new AgentTask(ctx, { ...options, retries: 2, retryDelay: 0, retryOn: () => false }); },
});
const result = await runner.run({ flowName: 'main' });
if (!result.success || factoryPhase !== 'task' || workerAttempts !== 1 || result.steps[0]?.result?.data?.toolCalls?.[0]?.ok !== false) throw new Error('packed nested-agent retry predicate failed');
console.log('packed nested-agent retry predicate: PASS');
`,
  );
  runNpm(['install', '--ignore-scripts', tarball], workspace);
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], workspace);
  run(process.execPath, ['runtime.mjs'], workspace);
  console.log('packed consumer: PASS');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
