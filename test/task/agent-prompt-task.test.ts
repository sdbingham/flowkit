import { describe, it, expect, vi } from 'vitest';
import { AgentPromptTask } from '../../src/task/agent-prompt-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';
import type { Logger } from '../../src/logger.js';

function makeTask(opts: Record<string, unknown>, provider?: LLMProvider) {
  return new AgentPromptTask({ llm: provider } as unknown as never, opts as never);
}

describe('AgentPromptTask', () => {
  it('uses the host retryOn predicate for its completion path', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('not retryable');
      },
    };

    const result = await makeTask(
      { prompt: 'x', retries: 2, retryDelay: 0, retryOn: () => false },
      provider,
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(1);
  });

  it('retries when its host retryOn predicate returns true', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('retryable');
      },
    };

    const result = await makeTask(
      { prompt: 'x', retries: 2, retryDelay: 0, retryOn: () => true },
      provider,
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(3);
  });

  it('retains retry-all behavior when its host retryOn predicate is omitted', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('default retryable');
      },
    };

    const result = await makeTask({ prompt: 'x', retries: 2, retryDelay: 0 }, provider).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(3);
  });

  it('forwards its task signal and makes zero calls when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const provider: LLMProvider = { async complete() { attempts++; return { text: 'unexpected' }; } };

    const result = await new AgentPromptTask(
      { llm: provider, signal: controller.signal } as never,
      { prompt: 'x', retries: 2 } as never,
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(0);
  });

  it('forwards task cancellation to an in-flight provider call', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        receivedSignal = req.signal;
        markStarted();
        return new Promise((resolve) => req.signal?.addEventListener('abort', () => resolve({ text: 'late' }), { once: true }));
      },
    };
    const task = new AgentPromptTask(
      { llm: provider, signal: controller.signal } as never,
      { prompt: 'x', retries: 2 } as never,
    );
    const completion = task.run();
    await started;
    controller.abort();

    const result = await completion;
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.success).toBe(false);
  });

  it('cancels retry backoff without another provider attempt and cleans source listeners', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let attempts = 0;
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { markBackoffStarted = resolve; });
    const logger: Logger = {
      debug: () => {}, info: () => {}, warn: (_data, message) => {
        if (message === 'LLM call failed; retrying') markBackoffStarted();
      }, error: () => {}, child: () => logger,
    };
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        throw new Error('retryable');
      },
    };

    const completion = new AgentPromptTask(
      { llm: provider, signal: controller.signal, logger } as never,
      { prompt: 'x', retries: 2, retryDelay: 10_000 } as never,
    ).run();
    await backoffStarted;
    controller.abort();

    await expect(completion).resolves.toMatchObject({ success: false, error: { name: 'LLMAbortError' } });
    expect(attempts).toBe(1);
    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
  });

  it('forwards task cancellation to an in-flight structured-output repair', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let repairStarted!: () => void;
    const repair = new Promise<void>((resolve) => { repairStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        attempts++;
        if (attempts === 1) return Promise.resolve({ text: 'not json' });
        repairStarted();
        return new Promise((resolve) => {
          req.signal?.addEventListener('abort', () => resolve({ text: '{"ok":true}' }), { once: true });
        });
      },
    };
    const task = new AgentPromptTask(
      { llm: provider, signal: controller.signal } as never,
      { prompt: 'x', schema: { type: 'object', required: ['ok'] }, repairAttempts: 1 } as never,
    );

    const result = task.run();
    await repair;
    controller.abort();

    await expect(result).resolves.toMatchObject({ success: false });
    expect(attempts).toBe(2);
  });

  it('uses retryOn for a structured-output repair transport error', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        if (attempts === 1) return { text: 'not json' };
        throw new Error('do not retry repair');
      },
    };

    const result = await makeTask(
      {
        prompt: 'x',
        schema: { type: 'object', required: ['ok'] },
        repairAttempts: 1,
        retries: 2,
        retryDelay: 0,
        retryOn: () => false,
      },
      provider,
    ).run();

    expect(result.success).toBe(false);
    expect(attempts).toBe(2);
  });

  it('cancels structured-output repair retry backoff without a later repair attempt', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => { markBackoffStarted = resolve; });
    const logger: Logger = {
      debug: () => {}, info: () => {}, warn: (_data, message) => {
        if (message === 'LLM call failed; retrying') markBackoffStarted();
      }, error: () => {}, child: () => logger,
    };
    const provider: LLMProvider = {
      async complete() {
        attempts++;
        if (attempts === 1) return { text: 'not json' };
        throw new Error('repair transport failure');
      },
    };

    const completion = new AgentPromptTask(
      { llm: provider, signal: controller.signal, logger } as never,
      {
        prompt: 'x',
        schema: { type: 'object', required: ['ok'] },
        repairAttempts: 1,
        retries: 2,
        retryDelay: 10_000,
      } as never,
    ).run();
    await backoffStarted;
    controller.abort();

    await expect(completion).resolves.toMatchObject({ success: false, error: { name: 'LLMAbortError' } });
    expect(attempts).toBe(2);
  });

  it('returns text in data when provider responds', async () => {
    const provider: LLMProvider = {
      async complete(req) {
        return { text: `echo: ${req.prompt}` };
      },
    };
    const task = makeTask({ prompt: 'hello' }, provider);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ text: 'echo: hello' });
  });

  it('passes through parsed and usage when provider returns them', async () => {
    const provider: LLMProvider = {
      async complete() {
        return {
          text: '{"ok":true}',
          parsed: { ok: true },
          usage: { inputTokens: 12, outputTokens: 3 },
        };
      },
    };
    const task = makeTask({ prompt: 'x', schema: { type: 'object' } }, provider);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('fails cleanly when no provider is configured', async () => {
    const task = makeTask({ prompt: 'x' }, undefined);
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/no LLM provider configured/);
  });

  it('fails validation when prompt is missing', async () => {
    const provider: LLMProvider = { async complete() { return { text: '' }; } };
    const task = makeTask({}, provider);
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/requires a `prompt`/);
  });

  it('validates structured output and surfaces raw text on failure', async () => {
    const provider: LLMProvider = { async complete() { return { text: 'not json' }; } };
    const schema = { type: 'object', required: ['ok'] };
    const task = makeTask({ prompt: 'x', schema, repairAttempts: 0 }, provider);
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.name).toBe('StructuredOutputError');
    expect(result.data?.text).toBe('not json');
  });

  it('flags truncated output via maxOutputChars', async () => {
    const provider: LLMProvider = { async complete() { return { text: 'x'.repeat(50) }; } };
    const task = makeTask({ prompt: 'x', maxOutputChars: 5 }, provider);
    const result = await task.run();
    expect(result.success).toBe(true);
    expect(result.data?.truncated).toBe(true);
    expect((result.data?.text as string).length).toBe(5);
  });

  it('passes finishReason and model through when reported', async () => {
    const provider: LLMProvider = {
      async complete() { return { text: 'hi', finishReason: 'stop', model: 'test-1' }; },
    };
    const task = makeTask({ prompt: 'x' }, provider);
    const result = await task.run();
    expect(result.data).toEqual({ text: 'hi', finishReason: 'stop', model: 'test-1' });
  });
});
