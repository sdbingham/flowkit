import { describe, it, expect } from 'vitest';
import { AgentPromptTask } from '../../src/task/agent-prompt-task.js';
import type { LLMProvider } from '../../src/task/llm-provider.js';

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
