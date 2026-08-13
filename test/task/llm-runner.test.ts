import { describe, it, expect, vi } from 'vitest';
import {
  runCompletion,
  pickRunOptions,
  LLMAbortError,
  LLMTimeoutError,
  StructuredOutputError,
} from '../../src/task/llm-runner.js';
import type { LLMProvider, LLMCompletionResponse } from '../../src/task/llm-provider.js';
import type { Logger } from '../../src/logger.js';

const ok = (text: string, extra: Partial<LLMCompletionResponse> = {}): LLMCompletionResponse => ({
  text,
  ...extra,
});

describe('runCompletion — transport', () => {
  it('preserves a host retryOn predicate by identity', () => {
    const retryOn = (err: Error) => err.name === 'transient';
    expect(pickRunOptions({ retries: 2, retryOn }).retryOn).toBe(retryOn);
  });

  it('passes through a successful response', async () => {
    const provider: LLMProvider = { async complete() { return ok('hi'); } };
    const res = await runCompletion(provider, { prompt: 'x' });
    expect(res.text).toBe('hi');
  });

  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async complete() {
        calls++;
        if (calls < 3) throw new Error('boom');
        return ok('recovered');
      },
    };
    const res = await runCompletion(provider, { prompt: 'x' }, { retries: 2, retryDelay: 1 });
    expect(res.text).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('gives up after exhausting retries', async () => {
    const provider: LLMProvider = { async complete() { throw new Error('always'); } };
    await expect(
      runCompletion(provider, { prompt: 'x' }, { retries: 1, retryDelay: 1 }),
    ).rejects.toThrow('always');
  });

  it('honors retryOn to skip non-retryable errors', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async complete() {
        calls++;
        throw new Error('fatal');
      },
    };
    await expect(
      runCompletion(provider, { prompt: 'x' }, { retries: 3, retryDelay: 1, retryOn: () => false }),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('does not call the provider when its request signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const provider: LLMProvider = { async complete() { calls++; return ok('unexpected'); } };

    await expect(runCompletion(provider, { prompt: 'x', signal: controller.signal })).rejects.toBeInstanceOf(LLMAbortError);
    expect(calls).toBe(0);
  });

  it('interrupts retry backoff when its request signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    let backoffStarted!: () => void;
    const backoff = new Promise<void>((resolve) => { backoffStarted = resolve; });
    const provider: LLMProvider = {
      async complete() {
        calls++;
        throw new Error('retryable');
      },
    };
    const logger: Logger = {
      debug: () => {}, info: () => {}, warn: () => backoffStarted(), error: () => {}, child: () => logger,
    };

    const completion = runCompletion(
      provider,
      { prompt: 'x', signal: controller.signal },
      { retries: 2, retryDelay: 10_000 },
      logger,
    );
    await backoff;
    controller.abort();

    await expect(completion).rejects.toBeInstanceOf(LLMAbortError);
    expect(calls).toBe(1);
  });

  it('removes source-signal listeners after a successful combined request', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const provider: LLMProvider = { async complete() { return ok('done'); } };

    await expect(runCompletion(provider, { prompt: 'x', signal: controller.signal }, { timeout: 100 })).resolves.toMatchObject({ text: 'done' });

    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
  });

  it('removes source-signal listeners after provider failure and timeout', async () => {
    for (const provider of [
      { async complete() { throw new Error('failed'); } },
      { complete: () => new Promise<LLMCompletionResponse>(() => {}) },
    ] satisfies LLMProvider[]) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      await expect(runCompletion(provider, { prompt: 'x', signal: controller.signal }, { timeout: 10, retries: 0 })).rejects.toBeInstanceOf(Error);
      expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
      expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('removes source-signal listeners after an in-flight request aborts', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        markStarted();
        return new Promise<LLMCompletionResponse>((resolve) => {
          req.signal?.addEventListener('abort', () => resolve(ok('late')), { once: true });
        });
      },
    };

    const completion = runCompletion(provider, { prompt: 'x', signal: controller.signal }, { timeout: 100 });
    await started;
    controller.abort();

    await expect(completion).rejects.toBeInstanceOf(LLMAbortError);
    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
  });

  it('does not register a listener for an already aborted source signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const provider: LLMProvider = { async complete() { return ok('unexpected'); } };

    await expect(runCompletion(provider, { prompt: 'x', signal: controller.signal }, { timeout: 10 })).rejects.toBeInstanceOf(LLMAbortError);
    expect(add).not.toHaveBeenCalled();
  });

  it('times out a slow call', async () => {
    const provider: LLMProvider = {
      complete: () => new Promise((resolve) => setTimeout(() => resolve(ok('late')), 100)),
    };
    await expect(
      runCompletion(provider, { prompt: 'x' }, { timeout: 20, retries: 0 }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  it('aborts the provider signal on timeout', async () => {
    let aborted = false;
    const provider: LLMProvider = {
      complete: (req) =>
        new Promise((resolve) => {
          req.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve(ok('late')), 100);
        }),
    };
    await expect(
      runCompletion(provider, { prompt: 'x' }, { timeout: 20, retries: 0 }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(aborted).toBe(true);
  });
});

describe('runCompletion — output cap', () => {
  it('truncates over-long text and flags it', async () => {
    const provider: LLMProvider = { async complete() { return ok('x'.repeat(100)); } };
    const res = await runCompletion(provider, { prompt: 'x' }, { maxOutputChars: 10 });
    expect(res.text).toHaveLength(10);
    expect(res.truncated).toBe(true);
  });
});

describe('runCompletion — structured output', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

  it('uses provider-supplied parsed when valid', async () => {
    const provider: LLMProvider = {
      async complete() { return ok('{"ok":true}', { parsed: { ok: true } }); },
    };
    const res = await runCompletion(provider, { prompt: 'x', schema });
    expect(res.parsed).toEqual({ ok: true });
  });

  it('parses JSON out of fenced text when parsed is absent', async () => {
    const provider: LLMProvider = {
      async complete() { return ok('```json\n{"ok":false}\n```'); },
    };
    const res = await runCompletion(provider, { prompt: 'x', schema });
    expect(res.parsed).toEqual({ ok: false });
  });

  it('repairs once on schema mismatch then succeeds', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      async complete() {
        calls++;
        return calls === 1 ? ok('{"ok":"nope"}') : ok('{"ok":true}');
      },
    };
    const res = await runCompletion(provider, { prompt: 'x', schema }, { repairAttempts: 1 });
    expect(calls).toBe(2);
    expect(res.parsed).toEqual({ ok: true });
  });

  it('throws StructuredOutputError when repair is exhausted', async () => {
    const provider: LLMProvider = { async complete() { return ok('not json at all'); } };
    await expect(
      runCompletion(provider, { prompt: 'x', schema }, { repairAttempts: 1 }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('repair conversation includes the validation errors', async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      async complete(req) {
        seen.push(req.messages?.map((m) => m.content).join('|') ?? '');
        return ok('{}');
      },
    };
    await expect(
      runCompletion(provider, { prompt: 'x', schema }, { repairAttempts: 1 }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    expect(seen[1]).toMatch(/Validation errors/);
  });

  it('cancels a structured-output repair and does not start another provider attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    let repairStarted!: () => void;
    const repair = new Promise<void>((resolve) => { repairStarted = resolve; });
    const provider: LLMProvider = {
      complete(req) {
        calls++;
        if (calls === 1) return Promise.resolve(ok('not json'));
        repairStarted();
        return new Promise<LLMCompletionResponse>((resolve) => {
          req.signal?.addEventListener('abort', () => resolve(ok('{"ok":true}')), { once: true });
        });
      },
    };

    const completion = runCompletion(
      provider,
      { prompt: 'x', schema, signal: controller.signal },
      { repairAttempts: 2 },
    );
    await repair;
    controller.abort();

    await expect(completion).rejects.toBeInstanceOf(LLMAbortError);
    expect(calls).toBe(2);
  });

  it('removes source-signal listeners after structured-output repair failure', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const provider: LLMProvider = { async complete() { return ok('not json'); } };

    await expect(
      runCompletion(provider, { prompt: 'x', schema, signal: controller.signal }, { repairAttempts: 1, timeout: 100 }),
    ).rejects.toBeInstanceOf(StructuredOutputError);

    expect(add.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
    expect(remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2);
  });
});
