import { describe, it, expect, vi } from 'vitest';
import { AgentTask } from '../../src/task/agent-task.js';
import { BaseTask, type TaskResult, type TaskContext } from '../../src/task/base-task.js';
import { TaskRegistry } from '../../src/task/registry.js';
import type { LLMProvider, LLMCompletionResponse } from '../../src/task/llm-provider.js';
import type { Logger } from '../../src/logger.js';

/** Provider that returns a scripted sequence of responses. */
function scripted(responses: LLMCompletionResponse[]): { provider: LLMProvider; count: () => number } {
  let i = 0;
  return {
    count: () => i,
    provider: {
      async complete() {
        const r = responses[Math.min(i, responses.length - 1)]!;
        i++;
        return r;
      },
    },
  };
}

const toolTurn = (id: string, name: string, args: Record<string, unknown>): LLMCompletionResponse => ({
  text: '',
  finishReason: 'tool_use',
  toolCalls: [{ id, name, arguments: args }],
});

const multiToolTurn = (
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage?: { inputTokens?: number; outputTokens?: number },
): LLMCompletionResponse => ({ text: '', finishReason: 'tool_use', toolCalls: calls, usage });

const finalTurn = (text: string): LLMCompletionResponse => ({ text, finishReason: 'stop' });

/** Echo task: returns its options as data. */
class EchoTask extends BaseTask<Record<string, unknown>> {
  get taskName() { return 'echo'; }
  async execute(): Promise<TaskResult> {
    return { success: true, data: { echoed: this.options } };
  }
}

function makeTask(opts: Record<string, unknown>, ctx: Partial<TaskContext>) {
  return new AgentTask(ctx as TaskContext, opts as never);
}

describe('AgentTask', () => {
  it('does not retry a provider error when host retryOn returns false', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('not retryable');
      },
    };

    const result = await makeTask(
      { prompt: 'x', retries: 2, retryDelay: 0, retryOn: () => false },
      { llm: provider },
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(1);
  });

  it('retries a provider error when host retryOn returns true', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('retryable');
      },
    };

    const result = await makeTask(
      { prompt: 'x', retries: 2, retryDelay: 0, retryOn: () => true },
      { llm: provider },
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(3);
  });

  it('retries all provider errors by default when retryOn is omitted', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('default retryable');
      },
    };

    const result = await makeTask({ prompt: 'x', retries: 2, retryDelay: 0 }, { llm: provider }).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(3);
  });

  it('uses retryOn for the structured final-answer completion path', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        if (attempts === 1) return finalTurn('not json');
        throw new Error('do not retry finalizer');
      },
    };

    const result = await makeTask(
      {
        prompt: 'x',
        retries: 2,
        retryDelay: 0,
        retryOn: () => false,
        schema: { type: 'object', required: ['ok'] },
      },
      { llm: provider },
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(2);
  });

  it('forwards task cancellation to every normal and structured completion turn', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    let attempts = 0;
    const provider: LLMProvider = {
      async complete(req) {
        signals.push(req.signal);
        attempts++;
        return attempts === 1 ? finalTurn('not json') : finalTurn('{"ok":true}');
      },
    };

    const result = await makeTask(
      { prompt: 'x', schema: { type: 'object', required: ['ok'] } },
      { llm: provider, signal: controller.signal },
    ).run();

    expect(result.success).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal !== undefined)).toBe(true);
  });

  it('does not call its provider when the task signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const provider: LLMProvider = { async complete() { attempts++; return finalTurn('unexpected'); } };

    const result = await makeTask({ prompt: 'x' }, { llm: provider, signal: controller.signal }).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(0);
  });

  it('cancels retry backoff without a later AgentTask provider attempt and cleans listeners', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let attempts = 0;
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { markBackoffStarted = resolve; });
    const logger: Logger = {
      debug: () => {}, info: () => {}, warn: () => markBackoffStarted(), error: () => {}, child: () => logger,
    };
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('retryable');
      },
    };

    const completion = makeTask(
      { prompt: 'x', retries: 2, retryDelay: 10_000 },
      { llm: provider, signal: controller.signal, logger } as TaskContext,
    ).run();
    await backoffStarted;
    controller.abort();

    await expect(completion).resolves.toMatchObject({ success: false, error: { name: 'LLMAbortError' } });
    expect(attempts).toBe(1);
    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
  });

  it('cancels an in-flight structured finalization through the task signal', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let finalizationStarted!: () => void;
    const finalization = new Promise<void>((resolve) => { finalizationStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        attempts++;
        if (attempts === 1) return Promise.resolve(finalTurn('not json'));
        finalizationStarted();
        return new Promise<LLMCompletionResponse>((resolve) => {
          req.signal?.addEventListener('abort', () => resolve(finalTurn('{"ok":true}')), { once: true });
        });
      },
    };

    const task = makeTask(
      { prompt: 'x', schema: { type: 'object', required: ['ok'] }, repairAttempts: 1 },
      { llm: provider, signal: controller.signal },
    );
    const result = task.run();
    await finalization;
    controller.abort();

    await expect(result).resolves.toMatchObject({ success: false });
    expect(attempts).toBe(2);
  });

  it('returns a final answer with no tools', async () => {
    const { provider } = scripted([finalTurn('done')]);
    const task = makeTask({ prompt: 'hi' }, { llm: provider });
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data?.text).toBe('done');
    expect(result.data?.iterations).toBe(1);
    expect(result.data?.toolCalls).toEqual([]);
  });

  it('fails cleanly with no provider', async () => {
    const task = makeTask({ prompt: 'hi' }, {});
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/no LLM provider/);
  });

  it('invokes a context handler tool then finishes', async () => {
    const { provider } = scripted([toolTurn('1', 'add', { a: 2, b: 3 }), finalTurn('sum is 5')]);
    let ran = false;
    const task = makeTask(
      {
        prompt: 'add 2 and 3',
        tools: [{ name: 'add', parameters: { type: 'object', required: ['a', 'b'] } }],
      },
      {
        llm: provider,
        agentTools: {
          add: (args) => {
            ran = true;
            return { sum: (args.a as number) + (args.b as number) };
          },
        },
      },
    );
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(ran).toBe(true);
    expect(result.data?.text).toBe('sum is 5');
    const calls = result.data?.toolCalls as Array<{ name: string; ok: boolean; result: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'add', ok: true });
    expect(calls[0]?.result).toContain('"sum":5');
  });

  it('invokes a task-backed tool through the registry', async () => {
    const { provider } = scripted([toolTurn('1', 'echo', { value: 42 }), finalTurn('ok')]);
    const registry = new TaskRegistry().register('echo', EchoTask as never);
    const task = makeTask(
      { prompt: 'use echo', tools: [{ task: 'echo' }] },
      { llm: provider, registry },
    );
    const result = await task.run();
    expect(result.success).toBe(true);
    const calls = result.data?.toolCalls as Array<{ name: string; ok: boolean; result: string }>;
    expect(calls[0]?.ok).toBe(true);
    expect(calls[0]?.result).toContain('42');
  });

  it('layers tool args over a configured task default', async () => {
    const { provider } = scripted([toolTurn('1', 'echo', { value: 42 }), finalTurn('ok')]);
    const registry = new TaskRegistry().register('echo', EchoTask as never);
    const task = makeTask(
      { prompt: 'use echo', tools: [{ task: 'echo' }] },
      {
        llm: provider,
        registry,
        taskDefinitions: { echo: { class_path: 'echo', options: { base: 'default' } } as never },
      },
    );
    const result = await task.run();
    const calls = result.data?.toolCalls as Array<{ result: string }>;
    expect(calls[0]?.result).toContain('"base":"default"');
    expect(calls[0]?.result).toContain('42');
  });

  it('rejects an unknown tool and feeds the error back', async () => {
    const { provider } = scripted([toolTurn('1', 'ghost', {}), finalTurn('recovered')]);
    const task = makeTask({ prompt: 'x', tools: [{ name: 'add' }] }, { llm: provider });
    const result = await task.run();
    expect(result.success).toBe(true);
    const calls = result.data?.toolCalls as Array<{ name: string; ok: boolean; result: string }>;
    expect(calls[0]).toMatchObject({ name: 'ghost', ok: false });
    expect(calls[0]?.result).toMatch(/unknown tool/);
  });

  it('rejects invalid tool arguments against the parameters schema', async () => {
    const { provider } = scripted([toolTurn('1', 'add', { a: 'oops' }), finalTurn('done')]);
    const task = makeTask(
      {
        prompt: 'x',
        tools: [{ name: 'add', parameters: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } } }],
      },
      { llm: provider, agentTools: { add: () => 0 } },
    );
    const result = await task.run();
    const calls = result.data?.toolCalls as Array<{ ok: boolean; result: string }>;
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.result).toMatch(/invalid arguments/);
  });

  it('fails when the model never stops calling tools', async () => {
    const { provider } = scripted([toolTurn('1', 'add', {})]); // always a tool call
    const task = makeTask(
      { prompt: 'x', maxIterations: 3, tools: [{ name: 'add' }] },
      { llm: provider, agentTools: { add: () => 0 } },
    );
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/exceeded maxIterations \(3\)/);
    expect(result.data?.iterations).toBe(3);
  });

  it('produces a validated structured final answer', async () => {
    const { provider } = scripted([
      finalTurn('the answer is 5'),
      { text: '{"answer":5}', finishReason: 'stop' },
    ]);
    const task = makeTask(
      { prompt: 'x', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } } },
      { llm: provider },
    );
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data?.parsed).toEqual({ answer: 5 });
  });

  it('requires a tokenBudget when the toolset includes an agent', async () => {
    const { provider } = scripted([finalTurn('done')]);
    const task = makeTask({ prompt: 'x', tools: [{ agent: 'worker' }] }, { llm: provider });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/must set a `tokenBudget`/);
  });

  it('allows agent tools without an own budget when running under one', async () => {
    const { provider } = scripted([finalTurn('done')]);
    const task = makeTask(
      { prompt: 'x', tools: [{ agent: 'worker' }] },
      { llm: provider, __tokenLedger: { limit: 1000, spent: 0 } },
    );
    const result = await task.run();
    expect(result.success).toBe(true);
  });

  it('invokes a flow tool via ctx.runFlow', async () => {
    const { provider } = scripted([toolTurn('1', 'ci', {}), finalTurn('ok')]);
    let called = '';
    const task = makeTask(
      { prompt: 'x', tools: [{ flow: 'ci' }] },
      {
        llm: provider,
        runFlow: async (name) => {
          called = name;
          return { success: true, data: { steps: { build: { ok: true } } } };
        },
      },
    );
    const result = await task.run();
    expect(called).toBe('ci');
    const calls = result.data?.toolCalls as Array<{ name: string; ok: boolean; result: string }>;
    expect(calls[0]).toMatchObject({ name: 'ci', ok: true });
    expect(calls[0]?.result).toContain('steps');
  });

  it('invokes a sub-agent via ctx.runAgent with incremented depth', async () => {
    const { provider } = scripted([toolTurn('1', 'worker', { prompt: 'sub' }), finalTurn('ok')]);
    let seenDepth = -1;
    let seenPrompt = '';
    const task = makeTask(
      { prompt: 'x', tokenBudget: 100000, tools: [{ agent: 'worker' }] },
      {
        llm: provider,
        __agentDepth: 2,
        runAgent: async (_name, input, depth) => {
          seenDepth = depth;
          seenPrompt = String(input.prompt);
          return { success: true, data: { text: 'sub-done' } };
        },
      },
    );
    const result = await task.run();
    expect(seenDepth).toBe(3);
    expect(seenPrompt).toBe('sub');
    const calls = result.data?.toolCalls as Array<{ ok: boolean; result: string }>;
    expect(calls[0]?.ok).toBe(true);
    expect(calls[0]?.result).toContain('sub-done');
  });

  it('refuses to nest past maxAgentDepth', async () => {
    const { provider } = scripted([toolTurn('1', 'worker', {}), finalTurn('done')]);
    let ran = false;
    const task = makeTask(
      { prompt: 'x', tokenBudget: 100000, maxAgentDepth: 2, tools: [{ agent: 'worker' }] },
      {
        llm: provider,
        __agentDepth: 2,
        runAgent: async () => {
          ran = true;
          return { success: true };
        },
      },
    );
    const result = await task.run();
    expect(ran).toBe(false);
    const calls = result.data?.toolCalls as Array<{ ok: boolean; result: string }>;
    expect(calls[0]?.ok).toBe(false);
    expect(calls[0]?.result).toMatch(/max agent depth/);
  });

  it('runs a turn\'s tool calls concurrently', async () => {
    const { provider } = scripted([
      multiToolTurn([
        { id: '1', name: 'work', arguments: { n: 1 } },
        { id: '2', name: 'work', arguments: { n: 2 } },
        { id: '3', name: 'work', arguments: { n: 3 } },
      ]),
      finalTurn('done'),
    ]);
    let inFlight = 0;
    let peak = 0;
    const task = makeTask(
      { prompt: 'x', tools: [{ name: 'work' }] },
      {
        llm: provider,
        agentTools: {
          work: async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight--;
            return 'ok';
          },
        },
      },
    );
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect((result.data?.toolCalls as unknown[]).length).toBe(3);
  });

  it('fails once the token budget is exhausted', async () => {
    const { provider } = scripted([
      multiToolTurn([{ id: '1', name: 'work', arguments: {} }], { inputTokens: 100, outputTokens: 100 }),
      finalTurn('should not reach'),
    ]);
    const task = makeTask(
      { prompt: 'x', tokenBudget: 150, tools: [{ name: 'work' }] },
      { llm: provider, agentTools: { work: () => 'ok' } },
    );
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/token budget \(150\)/);
    expect((result.data?.usage as { inputTokens: number }).inputTokens).toBe(100);
  });

  it('truncates oversized tool results', async () => {
    const { provider } = scripted([toolTurn('1', 'big', {}), finalTurn('done')]);
    const task = makeTask(
      { prompt: 'x', maxToolResultChars: 10, tools: [{ name: 'big' }] },
      { llm: provider, agentTools: { big: () => 'y'.repeat(100) } },
    );
    const result = await task.run();
    const calls = result.data?.toolCalls as Array<{ result: string }>;
    expect(calls[0]?.result.length).toBeLessThan(40);
    expect(calls[0]?.result).toMatch(/more chars/);
  });
});
