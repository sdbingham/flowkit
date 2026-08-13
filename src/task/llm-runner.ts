/**
 * The single place every LLM call goes through.
 *
 * `runCompletion` wraps a raw provider with the cross-cutting concerns that make
 * model calls production-safe — and does so once, so both the single-shot
 * `AgentPromptTask` and the agentic `AgentTask` inherit identical behavior:
 *
 *   - timeout + abort  — bound every call; abort the provider's in-flight request
 *   - retry + backoff  — exponential backoff on transient transport failures
 *   - structured output — validate against the requested JSON Schema and, on a
 *                         mismatch, re-prompt the model with the concrete errors
 *                         (the "repair loop") before giving up
 *   - output cap       — bound response text so a runaway generation can't blow
 *                         up memory or downstream logs
 */

import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
} from './llm-provider.js';
import { validateJson, formatErrors } from './json-schema.js';

export interface LLMRunOptions {
  /** Per-call timeout in ms. Default 60000. `0` disables the timeout. */
  timeout?: number;
  /** Transport retries (in addition to the first attempt). Default 2. */
  retries?: number;
  /** Base backoff in ms; doubles each retry. Default 500. */
  retryDelay?: number;
  /** Decide whether a given error is retryable. Default: retry everything. */
  retryOn?: (err: Error) => boolean;
  /** Structured-output repair re-prompts before failing. Default 1. */
  repairAttempts?: number;
  /** Cap on response text length. Default 0 (unlimited). */
  maxOutputChars?: number;
}

/** Response plus runner-added metadata. */
export type LLMRunResult = LLMCompletionResponse & {
  /** True when `maxOutputChars` clipped the text. */
  truncated?: boolean;
};

/**
 * The subset of `LLMRunOptions` that is plain data, so it can be declared in
 * YAML task options. `retryOn` is excluded because it is a function. Both agent
 * tasks mix these into their option shape; `pickRunOptions` extracts them.
 */
export interface AgentRunFields {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  repairAttempts?: number;
  maxOutputChars?: number;
}

/**
 * Programmatic-only retry control for agent tasks. This deliberately stays out
 * of `AgentRunFields`, whose members remain safe to declare in YAML.
 */
export interface AgentRetryOptions {
  /** Decide whether a thrown provider error is retryable. Default: retry all errors. */
  retryOn?: (err: Error) => boolean;
}

/** Lift the run-control fields out of a task's options into `LLMRunOptions`. */
export function pickRunOptions(o: AgentRunFields & AgentRetryOptions): LLMRunOptions {
  const out: LLMRunOptions = {};
  if (o.timeout !== undefined) out.timeout = o.timeout;
  if (o.retries !== undefined) out.retries = o.retries;
  if (o.retryDelay !== undefined) out.retryDelay = o.retryDelay;
  if (o.retryOn !== undefined) out.retryOn = o.retryOn;
  if (o.repairAttempts !== undefined) out.repairAttempts = o.repairAttempts;
  if (o.maxOutputChars !== undefined) out.maxOutputChars = o.maxOutputChars;
  return out;
}

/** A provider call exceeded its timeout. */
export class LLMTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

/** Structured output never satisfied the schema, even after repair attempts. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
    readonly validationErrors: string,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

export async function runCompletion(
  provider: LLMProvider,
  request: LLMCompletionRequest,
  options: LLMRunOptions = {},
  logger: Logger = noopLogger,
): Promise<LLMRunResult> {
  const {
    timeout = 60_000,
    retries = 2,
    retryDelay = 500,
    retryOn,
    repairAttempts = 1,
    maxOutputChars = 0,
  } = options;

  // The first call goes out exactly as the caller framed it (a bare `prompt`
  // stays a `prompt`). Only when a repair turn must be appended do we fall back
  // to a `messages` conversation, seeded from the original prompt/messages.
  let currentReq = request;
  let repairsLeft = request.schema ? repairAttempts : 0;
  let history: LLMMessage[] = request.messages
    ? [...request.messages]
    : request.prompt != null
      ? [{ role: 'user', content: request.prompt }]
      : [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await callWithRetry(
      provider,
      currentReq,
      { timeout, retries, retryDelay, retryOn },
      logger,
    );
    const resp = capOutput(raw, maxOutputChars, logger);

    if (!request.schema) return resp;

    const coerced = coerceStructured(resp, request.schema);
    if (!coerced.errors) return { ...resp, parsed: coerced.parsed };

    if (repairsLeft <= 0) {
      throw new StructuredOutputError(
        `LLM output failed schema validation: ${coerced.errors}`,
        resp.text,
        coerced.errors,
      );
    }
    repairsLeft--;
    logger.warn(
      { errors: coerced.errors, repairsLeft },
      'LLM structured output failed validation; requesting repair',
    );
    history = [
      ...history,
      { role: 'assistant', content: resp.text },
      { role: 'user', content: repairInstruction(coerced.errors) },
    ];
    currentReq = { ...request, prompt: undefined, messages: history };
  }
}

// ---------------------------------------------------------------------------
// Transport: timeout + retry/backoff
// ---------------------------------------------------------------------------

async function callWithRetry(
  provider: LLMProvider,
  req: LLMCompletionRequest,
  cfg: { timeout: number; retries: number; retryDelay: number; retryOn?: (e: Error) => boolean },
  logger: Logger,
): Promise<LLMCompletionResponse> {
  let lastErr: Error = new Error('LLM call never executed');
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      return await callOnce(provider, req, cfg.timeout);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const canRetry = attempt < cfg.retries && (cfg.retryOn ? cfg.retryOn(lastErr) : true);
      if (!canRetry) break;
      const delay = cfg.retryDelay * 2 ** attempt;
      logger.warn(
        { attempt: attempt + 1, nextDelayMs: delay, error: lastErr.message },
        'LLM call failed; retrying',
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function callOnce(
  provider: LLMProvider,
  req: LLMCompletionRequest,
  timeout: number,
): Promise<LLMCompletionResponse> {
  if (!timeout || timeout <= 0) return provider.complete(req);

  const controller = new AbortController();
  const signal = req.signal ? anySignal([req.signal, controller.signal]) : controller.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LLMTimeoutError(`LLM call timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    return await Promise.race([provider.complete({ ...req, signal }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Combine abort signals — aborts when any input aborts. (Node-version safe.) */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    for (const s of signals) s.removeEventListener('abort', onAbort);
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * Coerce a response into a schema-conforming value: prefer the provider's
 * `parsed`, else parse JSON out of the text. Returns `{ parsed }` when valid or
 * `{ errors }` describing the mismatch. Exported so callers (e.g. the agent
 * loop) can check conformance without forcing an extra model call.
 */
export function coerceStructured(
  resp: LLMCompletionResponse,
  schema: Record<string, unknown>,
): { parsed?: unknown; errors?: string } {
  let candidate: unknown = resp.parsed;
  if (candidate === undefined) {
    const parsed = extractJson(resp.text);
    if (!parsed.ok) return { errors: `output is not valid JSON (${parsed.error})` };
    candidate = parsed.value;
  }
  const result = validateJson(candidate, schema);
  if (!result.valid) return { errors: formatErrors(result.errors) };
  return { parsed: candidate };
}

/** Parse JSON from model output, tolerating code fences and surrounding prose. */
function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const tryParse = (s: string) => {
    try {
      return { ok: true as const, value: JSON.parse(s) as unknown };
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  // Strip a ```json … ``` (or plain ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  // Last resort: slice from the first opening bracket to the last closing one.
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start !== -1 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return { ok: false, error: 'no parseable JSON found' };
}

function repairInstruction(errors: string): string {
  return (
    `Your previous response did not satisfy the required JSON schema. ` +
    `Validation errors: ${errors}. ` +
    `Respond again with ONLY valid JSON that satisfies the schema — no prose, no markdown fences.`
  );
}

// ---------------------------------------------------------------------------
// Output cap
// ---------------------------------------------------------------------------

function capOutput(resp: LLMCompletionResponse, maxChars: number, logger: Logger): LLMRunResult {
  if (!maxChars || maxChars <= 0 || resp.text.length <= maxChars) return resp;
  logger.warn(
    { length: resp.text.length, maxChars },
    'LLM output exceeded maxOutputChars; truncating',
  );
  return { ...resp, text: resp.text.slice(0, maxChars), truncated: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
