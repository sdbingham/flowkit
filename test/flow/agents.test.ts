import { describe, it, expect } from 'vitest';
import {
  FlowRunner,
  type NestedAgentTaskFactory,
} from '../../src/flow/runner.js';
import { TaskRegistry } from '../../src/task/registry.js';
import { BaseTask, type TaskContext, type TaskResult } from '../../src/task/base-task.js';
import { AgentTask } from '../../src/task/agent-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';
import type { AgentDefinition } from '../../src/config/schema.js';
import type { AgentTaskOptions } from '../../src/task/agent-task.js';

class EchoTask extends BaseTask<Record<string, unknown>> {
  get taskName() { return 'echo'; }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { echoed: this.options } };
  }
}

/** Provider that routes by the system prompt so multiple agents share one stub. */
function branchingProvider(): LLMProvider {
  const counts: Record<string, number> = {};
  return {
    async complete(req) {
      const sys = req.system ?? '';
      counts[sys] = (counts[sys] ?? 0) + 1;
      const n = counts[sys];
      if (sys.includes('WORKER')) return { text: 'worker-done', finishReason: 'stop' };
      if (sys.includes('COORD')) {
        return n === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'sub' } }] }
          : { text: 'coord-done', finishReason: 'stop' };
      }
      if (sys.includes('BUILDER')) {
        return n === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'ci', arguments: {} }] }
          : { text: 'built', finishReason: 'stop' };
      }
      return { text: 'noop', finishReason: 'stop' };
    },
  };
}

function runner(
  agents: Record<string, AgentDefinition>,
  flows: Record<string, unknown>,
  tasks: Record<string, unknown> = {},
  provider: LLMProvider = branchingProvider(),
) {
  const registry = new TaskRegistry().register('echo', EchoTask as never);
  return new FlowRunner({
    tasks: tasks as never,
    flows: flows as never,
    agents,
    registry,
    context: { llm: provider },
  });
}

describe('FlowRunner agents', () => {
  it('preserves a host retry predicate through direct runTask agent resolution', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('host-classified non-retryable failure');
      },
    };
    const r = runner({ worker: { system: 'WORKER' } as never }, {}, {}, provider);

    const result = await r.runTask('worker', {
      prompt: 'go',
      retries: 2,
      retryDelay: 0,
      retryOn: () => false,
    });

    expect(result.success).toBe(false);
    expect(attempts).toBe(1);
  });

  it('lets a nested-agent factory supply a host retry predicate', async () => {
    let coordAttempts = 0;
    let workerAttempts = 0;
    const provider: LLMProvider = {
      async complete(req) {
        if ((req.system ?? '').includes('WORKER')) {
          workerAttempts++;
          throw new Error('host-classified non-retryable failure');
        }
        coordAttempts++;
        return coordAttempts === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'sub' } }] }
          : { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const factory: NestedAgentTaskFactory = (ctx, options) =>
      new AgentTask(ctx, { ...options, retries: 2, retryDelay: 0, retryOn: () => false });
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } },
        worker: { system: 'WORKER' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider },
      nestedAgentTaskFactory: factory,
    });

    const result = await r.run({ flowName: 'main' });

    expect(result.success).toBe(true);
    expect(workerAttempts).toBe(1);
    const toolCalls = result.steps[0]?.result?.data?.toolCalls as Array<{ ok: boolean }>;
    expect(toolCalls[0]?.ok).toBe(false);
  });

  it('forwards the run signal to a nested configured agent', async () => {
    const controller = new AbortController();
    let coordinatorAttempts = 0;
    let workerAttempts = 0;
    let workerSignal: AbortSignal | undefined;
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => { markWorkerStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        if ((req.system ?? '').includes('WORKER')) {
          workerAttempts++;
          workerSignal = req.signal;
          markWorkerStarted();
          return new Promise((resolve) => req.signal?.addEventListener('abort', () => resolve({ text: 'late', finishReason: 'stop' }), { once: true }));
        }
        coordinatorAttempts++;
        return Promise.resolve(coordinatorAttempts === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'sub' } }] }
          : { text: 'coord-done', finishReason: 'stop' });
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } },
        worker: { system: 'WORKER' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider, signal: controller.signal },
      nestedAgentTaskFactory: (ctx, options) => new AgentTask(ctx, options),
    });

    const resultPromise = r.run({ flowName: 'main' });
    await workerStarted;
    controller.abort();
    const result = await resultPromise;

    expect(workerAttempts).toBe(1);
    expect(workerSignal?.aborted).toBe(true);
    expect(result.success).toBe(false);
  });

  it('runs an agent as a flow step', async () => {
    const r = runner(
      { builder: { system: 'BUILDER', tools: [] } as never },
      { main: { steps: { 1: { task: 'builder', options: { prompt: 'go' } } } } },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    expect(res.steps[0]?.result?.data?.text).toBe('built');
  });

  it('lets an agent call a flow as a tool', async () => {
    const r = runner(
      { builder: { system: 'BUILDER', tools: [{ flow: 'ci' }] } as never },
      {
        ci: { steps: { 1: { task: 'echo', options: { n: 1 } } } },
        main: { steps: { 1: { task: 'builder', options: { prompt: 'go' } } } },
      },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { text: string; toolCalls: Array<{ name: string; ok: boolean; result: string }> };
    expect(data.text).toBe('built');
    expect(data.toolCalls[0]).toMatchObject({ name: 'ci', ok: true });
    expect(data.toolCalls[0]?.result).toContain('echoed');
  });

  it('lets an agent call a sub-agent as a tool', async () => {
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'delegate' } } } } },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { text: string; toolCalls: Array<{ name: string; ok: boolean; result: string }> };
    expect(data.text).toBe('coord-done');
    expect(data.toolCalls[0]).toMatchObject({ name: 'worker', ok: true });
    expect(data.toolCalls[0]?.result).toContain('worker-done');
  });

  it('charges sub-agent spend against the parent budget (aggregate ceiling)', async () => {
    // coord burns 100, then its sub-agent worker burns 200 against the shared
    // ledger; coord's 250 budget then trips on the next turn.
    const provider: LLMProvider = {
      async complete(req) {
        const sys = req.system ?? '';
        if (sys.includes('WORKER')) {
          return { text: 'w', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 100 } };
        }
        // COORD: always ask for the worker, so only the budget can stop it.
        return {
          text: '',
          finishReason: 'tool_use',
          toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 's' } }],
          usage: { inputTokens: 50, outputTokens: 50 },
        };
      },
    };
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 250 } } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } },
      {},
      provider,
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(false);
    expect(res.steps[0]?.result?.error?.message).toMatch(/token budget \(250\)/);
  });

  it('does not truncate a sub-agent result like opaque tool output', async () => {
    const big = 'x'.repeat(9000);
    const provider: LLMProvider = {
      async complete(req) {
        const sys = req.system ?? '';
        if (sys.includes('WORKER')) return { text: big, finishReason: 'stop' };
        const counts = (provider as { _n?: number })._n ?? 0;
        (provider as { _n?: number })._n = counts + 1;
        return counts === 0
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 's' } }] }
          : { text: 'done', finishReason: 'stop' };
      },
    };
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } },
      {},
      provider,
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { toolCalls: Array<{ result: string }> };
    expect(data.toolCalls[0]?.result.length).toBeGreaterThan(8000);
  });

  it('resolves a task tool\'s configured defaults inside a sub-agent', async () => {
    // The reference scope has to reach a task invoked as a tool however deep the
    // agent nesting goes, or the same tool behaves differently by call site.
    const provider: LLMProvider = {
      async complete(req) {
        const sys = req.system ?? '';
        const state = provider as { _w?: number; _c?: number };
        if (sys.includes('WORKER')) {
          state._w = (state._w ?? 0) + 1;
          return state._w === 1
            ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'echo', arguments: { extra: '${project.name}' } }] }
            : { text: 'worker-done', finishReason: 'stop' };
        }
        state._c = (state._c ?? 0) + 1;
        return state._c === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 's' } }] }
          : { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const registry = new TaskRegistry().registerClassPath('vendor.tasks.Echo', EchoTask as never);
    const r = new FlowRunner({
      tasks: { echo: { class_path: 'vendor.tasks.Echo', options: { org: '${org.username}' } } } as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } },
        worker: { system: 'WORKER', tools: [{ task: 'echo' }] },
      } as never,
      registry,
      context: { llm: provider },
      references: { org: { username: 'admin@example.com' } },
    });
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { toolCalls: Array<{ result: string }> };
    // The sub-agent's tool result carries the echoed options: the configured
    // default interpolated, the model's own argument left literal.
    expect(data.toolCalls[0]?.result).toContain('admin@example.com');
    expect(data.toolCalls[0]?.result).toContain('${project.name}');
  });

  it('interpolates a sub-agent\'s own configured options, but not its prompt', async () => {
    // An agent's compiled options are configuration wherever it is invoked from.
    // Reaching it as a sub-agent tool must resolve `${...}` in its system prompt
    // exactly as running it as a flow step does.
    const systems: string[] = [];
    const provider: LLMProvider = {
      async complete(req) {
        systems.push(req.system ?? '');
        const state = provider as { _c?: number };
        if ((req.system ?? '').includes('WORKER')) return { text: 'worker-done', finishReason: 'stop' };
        state._c = (state._c ?? 0) + 1;
        return state._c === 1
          ? {
              text: '',
              finishReason: 'tool_use',
              toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'literal ${org.username}' } }],
            }
          : { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: {
          system: 'COORD for ${org.username}',
          tools: [{ agent: 'worker' }],
          budget: { tokenBudget: 100000 },
        },
        worker: { system: 'WORKER for ${org.username}' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider },
      references: { org: { username: 'admin@example.com' } },
    });
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(true);
    // Step-invoked and sub-agent-invoked resolve identically.
    expect(systems[0]).toBe('COORD for admin@example.com');
    expect(systems[1]).toBe('WORKER for admin@example.com');
    // The caller's prompt is runtime input and stays literal.
    const data = res.steps[0]?.result?.data as { toolCalls: Array<{ arguments: { prompt: string } }> };
    expect(data.toolCalls[0]?.arguments.prompt).toBe('literal ${org.username}');
  });

  it('fails an agent that has agent tools but no budget', async () => {
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }] } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } },
    );
    const res = await r.run({ flowName: 'main' });
    expect(res.success).toBe(false);
    expect(res.steps[0]?.result?.error?.message).toMatch(/must set a `tokenBudget`/);
  });

  it('keeps default nested agent behavior equivalent to AgentTask construction', async () => {
    const r = runner(
      {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } } as never,
        worker: { system: 'WORKER', tools: [] } as never,
      },
      { main: { steps: { 1: { task: 'coord', options: { prompt: 'delegate' } } } } },
    );

    const res = await r.run({ flowName: 'main' });

    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as { text: string; toolCalls: Array<{ name: string; ok: boolean; result: string }> };
    expect(data).toMatchObject({
      text: 'coord-done',
      toolCalls: [{ name: 'worker', ok: true }],
    });
    expect(data.toolCalls[0]?.result).toContain('worker-done');
  });

  it('invokes the nested agent factory only for agent tool execution', async () => {
    const calls: Array<{ ctx: TaskContext; options: AgentTaskOptions }> = [];
    const factory: NestedAgentTaskFactory = (ctx, options) => {
      calls.push({ ctx, options });
      return { run: async () => ({ success: true, data: { text: 'factory-worker' } }) };
    };
    const provider: LLMProvider = {
      async complete(req) {
        const state = provider as { _c?: number };
        if ((req.system ?? '').includes('SOLO')) return { text: 'solo-done', finishReason: 'stop' };
        state._c = (state._c ?? 0) + 1;
        return state._c === 1
          ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'sub' } }] }
          : { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: {
        direct: { steps: { 1: { task: 'solo', options: { prompt: 'go' } } } },
        nested: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } },
      } as never,
      agents: {
        solo: { system: 'SOLO' },
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } },
        worker: { system: 'WORKER' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider },
      nestedAgentTaskFactory: factory,
    });

    const direct = await r.run({ flowName: 'direct' });
    expect(direct.success).toBe(true);
    expect(calls).toHaveLength(0);

    const nested = await r.run({ flowName: 'nested' });
    expect(nested.success).toBe(true);
    expect(calls).toHaveLength(1);
    const data = nested.steps[0]?.result?.data as { toolCalls: Array<{ result: string }> };
    expect(data.toolCalls[0]?.result).toContain('factory-worker');
  });

  it('passes the prepared child context and compiled options to the nested agent factory', async () => {
    const controller = new AbortController();
    const observations: Array<{ ctx: TaskContext; options: AgentTaskOptions }> = [];
    const factory: NestedAgentTaskFactory = (ctx, options) => {
      observations.push({ ctx, options });
      return { run: async () => ({ success: true, data: { text: 'worker-result' } }) };
    };
    const provider: LLMProvider = {
      async complete(req) {
        const state = provider as { _c?: number };
        state._c = (state._c ?? 0) + 1;
        return state._c === 1
          ? {
              text: '',
              finishReason: 'tool_use',
              toolCalls: [{ id: '1', name: 'worker', arguments: { prompt: 'literal ${org.username}' } }],
              usage: { inputTokens: 5, outputTokens: 7 },
            }
          : { text: 'done', finishReason: 'stop' };
      },
    };
    const registry = new TaskRegistry().register('echo', EchoTask as never);
    const r = new FlowRunner({
      tasks: { echo: { class_path: 'echo', options: { owner: '${org.username}' } } } as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: {
          system: 'COORD ${org.username}',
          tools: [{ agent: 'worker' }],
          budget: { tokenBudget: 100000 },
        },
        worker: {
          system: 'WORKER ${org.username}',
          tools: [{ task: 'echo' }],
          budget: { maxIterations: 3 },
        },
      } as never,
      registry,
      context: { llm: provider, signal: controller.signal },
      references: { org: { username: 'admin@example.com' } },
      nestedAgentTaskFactory: factory,
    });

    const res = await r.run({ flowName: 'main' });

    expect(res.success).toBe(true);
    expect(observations).toHaveLength(1);
    const { ctx, options } = observations[0]!;
    expect(options).toMatchObject({
      system: 'WORKER admin@example.com',
      prompt: 'literal ${org.username}',
      tools: [{ task: 'echo' }],
      maxIterations: 3,
    });
    expect(ctx.executionPhase).toBe('task');
    expect(ctx.registry).toBe(registry);
    expect(ctx.llm).toBe(provider);
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.taskDefinitions?.echo?.options).toEqual({ owner: '${org.username}' });
    expect(ctx.taskReferenceContext?.namespaces?.org).toEqual({ username: 'admin@example.com' });
    expect(ctx.__agentDepth).toBe(1);
    expect(ctx.__tokenLedger).toBeDefined();
    expect(typeof ctx.runFlow).toBe('function');
    expect(typeof ctx.runAgent).toBe('function');
  });

  it('lets a replacement task retain nested recursion, its shared ledger, and the run signal', async () => {
    const controller = new AbortController();
    const calls: Array<{ ctx: TaskContext; options: AgentTaskOptions }> = [];
    const factory: NestedAgentTaskFactory = (ctx, options) => {
      calls.push({ ctx, options });
      return new AgentTask(ctx, options);
    };
    const counts: Record<string, number> = {};
    const provider: LLMProvider = {
      async complete(req) {
        const system = req.system ?? '';
        counts[system] = (counts[system] ?? 0) + 1;
        if (system === 'COORD') {
          return counts[system] === 1
            ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: 'coord-1', name: 'worker', arguments: { prompt: 'delegate' } }] }
            : { text: 'coord-done', finishReason: 'stop' };
        }
        if (system === 'WORKER') {
          return counts[system] === 1
            ? { text: '', finishReason: 'tool_use', toolCalls: [{ id: 'worker-1', name: 'leaf', arguments: { prompt: 'finish' } }] }
            : { text: 'worker-done', finishReason: 'stop' };
        }
        return { text: 'leaf-done', finishReason: 'stop' };
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: { system: 'COORD', tools: [{ agent: 'worker' }], budget: { tokenBudget: 100000 } },
        worker: { system: 'WORKER', tools: [{ agent: 'leaf' }] },
        leaf: { system: 'LEAF' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider, signal: controller.signal },
      nestedAgentTaskFactory: factory,
    });

    const res = await r.run({ flowName: 'main' });

    expect(res.success).toBe(true);
    expect(calls.map(({ options }) => options.system)).toEqual(['WORKER', 'LEAF']);
    expect(calls.map(({ ctx }) => ctx.__agentDepth)).toEqual([1, 2]);
    expect(calls[0]?.ctx.__tokenLedger).toBeDefined();
    expect(calls[1]?.ctx.__tokenLedger).toBe(calls[0]?.ctx.__tokenLedger);
    expect(calls.map(({ ctx }) => ctx.signal)).toEqual([controller.signal, controller.signal]);
    expect(calls.map(({ ctx }) => ctx.executionPhase)).toEqual(['task', 'task']);
  });

  it('converts nested factory construction and run errors into normal tool failures', async () => {
    const factory: NestedAgentTaskFactory = (_ctx, options) => {
      if (options.prompt === 'throw') throw new Error('factory failed');
      return { run: async () => Promise.reject(new Error('nested run failed')) };
    };
    const provider: LLMProvider = {
      async complete() {
        const state = provider as { _n?: number };
        state._n = (state._n ?? 0) + 1;
        return state._n === 1
          ? {
              text: '',
              finishReason: 'tool_use',
              toolCalls: [
                { id: '1', name: 'worker', arguments: { prompt: 'throw' } },
                { id: '2', name: 'worker', arguments: { prompt: 'reject' } },
              ],
            }
          : { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: {
          system: 'COORD',
          tools: [{ agent: 'worker' }],
          budget: { tokenBudget: 100000, maxConcurrency: 1 },
        },
        worker: { system: 'WORKER' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider },
      nestedAgentTaskFactory: factory,
    });

    const res = await r.run({ flowName: 'main' });

    expect(res.success).toBe(true);
    const data = res.steps[0]?.result?.data as {
      toolCalls: Array<{ name: string; ok: boolean; result: string }>;
    };
    expect(data.toolCalls).toMatchObject([
      { name: 'worker', ok: false, result: 'Error: factory failed' },
      { name: 'worker', ok: false, result: 'Error: nested run failed' },
    ]);
  });

  it('keeps nested factory success and failure result shapes compatible', async () => {
    const calls: string[] = [];
    const factory: NestedAgentTaskFactory = (_ctx, options) => {
      calls.push(options.prompt);
      return {
        run: async () =>
          options.prompt === 'fail'
            ? { success: false, error: new Error('nested failed') }
            : { success: true, data: { text: 'nested ok' } },
      };
    };
    const provider: LLMProvider = {
      async complete() {
        const state = provider as { _n?: number };
        state._n = (state._n ?? 0) + 1;
        if (state._n === 1) {
          return {
            text: '',
            finishReason: 'tool_use',
            toolCalls: [
              { id: '1', name: 'worker', arguments: { prompt: 'ok' } },
              { id: '2', name: 'worker', arguments: { prompt: 'fail' } },
            ],
          };
        }
        return { text: 'coord-done', finishReason: 'stop' };
      },
    };
    const r = new FlowRunner({
      tasks: {} as never,
      flows: { main: { steps: { 1: { task: 'coord', options: { prompt: 'go' } } } } } as never,
      agents: {
        coord: {
          system: 'COORD',
          tools: [{ agent: 'worker' }],
          budget: { tokenBudget: 100000, maxConcurrency: 1 },
        },
        worker: { system: 'WORKER' },
      } as never,
      registry: new TaskRegistry(),
      context: { llm: provider },
      nestedAgentTaskFactory: factory,
    });

    const res = await r.run({ flowName: 'main' });

    expect(res.success).toBe(true);
    expect(calls).toEqual(['ok', 'fail']);
    const data = res.steps[0]?.result?.data as {
      text: string;
      toolCalls: Array<{ name: string; ok: boolean; result: string }>;
    };
    expect(data.text).toBe('coord-done');
    expect(data.toolCalls).toMatchObject([
      { name: 'worker', ok: true },
      { name: 'worker', ok: false, result: 'Error: nested failed' },
    ]);
    expect(data.toolCalls[0]?.result).toContain('nested ok');
  });
});
