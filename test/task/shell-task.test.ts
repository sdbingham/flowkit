import { mkdtemp, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ShellTask } from '../../src/task/shell-task.js';
import type { Logger } from '../../src/logger.js';

const SHELL_TASK_CANCELLED_MESSAGE = 'Shell command cancelled';

interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function makeCapturingLogger(): { logger: Logger; captured: CapturedLog[] } {
  const captured: CapturedLog[] = [];
  const logger: Logger = {
    debug: (...args) => captured.push({ level: 'debug', args }),
    info: (...args) => captured.push({ level: 'info', args }),
    warn: (...args) => captured.push({ level: 'warn', args }),
    error: (...args) => captured.push({ level: 'error', args }),
    child: () => logger,
  };
  return { logger, captured };
}

function linesFor(captured: CapturedLog[], stream: 'stdout' | 'stderr'): string[] {
  const level = stream === 'stdout' ? 'info' : 'warn';
  const out: string[] = [];
  for (const entry of captured) {
    if (entry.level !== level) continue;
    const [bindings, msg] = entry.args;
    if (
      bindings &&
      typeof bindings === 'object' &&
      (bindings as { stream?: string }).stream === stream &&
      typeof msg === 'string'
    ) {
      out.push(msg);
    }
  }
  return out;
}

function nodeCommand(source: string): string {
  // Base64 keeps the command valid for both cmd.exe and POSIX shells.
  const encoded = Buffer.from(source).toString('base64');
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}', 'base64').toString())"`;
}

function expectSingleListenerCleanup(
  addListener: ReturnType<typeof vi.spyOn>,
  removeListener: ReturnType<typeof vi.spyOn>,
) {
  const addCall = addListener.mock.calls.find(([type]) => type === 'abort');
  expect(addCall).toBeDefined();
  const handler = addCall?.[1];
  expect(
    removeListener.mock.calls.filter(([type, candidate]) => type === 'abort' && candidate === handler),
  ).toHaveLength(1);
}

describe('ShellTask', () => {
  it('streams stdout line-by-line through the logger', async () => {
    const { logger, captured } = makeCapturingLogger();
    const command =
      process.platform === 'win32'
        ? 'echo first&& echo second&& echo third'
        : 'printf "first\\nsecond\\nthird\\n"';
    const task = new ShellTask({ logger }, { command });
    const result = await task.run();
    expect(result.success, JSON.stringify(result)).toBe(true);
    const stdoutLines = linesFor(captured, 'stdout');
    // On Windows the echo&& chain emits trailing spaces; trim before compare.
    expect(stdoutLines.map((l) => l.trim())).toEqual(['first', 'second', 'third']);
    expect((result.data as { output: string }).output.replace(/\r/g, '')).toContain('first');
  });

  it('streams stderr line-by-line through the logger as warnings', async () => {
    const { logger, captured } = makeCapturingLogger();
    // Cross-platform stderr echo: redirect from a process that writes to it.
    const command =
      process.platform === 'win32'
        ? 'echo oops 1>&2'
        : 'printf "oops\\n" 1>&2';
    const task = new ShellTask({ logger }, { command });
    const result = await task.run();
    expect(result.success).toBe(true);
    const stderrLines = linesFor(captured, 'stderr');
    expect(stderrLines.map((l) => l.trim())).toContain('oops');
  });

  it('returns failure with captured stderr when the command exits non-zero', async () => {
    const command =
      process.platform === 'win32'
        ? 'echo failing 1>&2 && exit 1'
        : 'printf "failing\\n" 1>&2 && exit 1';
    const task = new ShellTask({}, { command });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/exit 1/);
    expect((result.data as { exitCode: number }).exitCode).toBe(1);
  });

  it('captures a final partial line once without a signal', async () => {
    const task = new ShellTask({}, { command: nodeCommand("process.stdout.write('partial')") });
    const result = await task.run();

    expect(result.success).toBe(true);
    expect((result.data as { output: string }).output).toBe('partial');
  });

  it('captures a final partial line once when a signal is supplied', async () => {
    const controller = new AbortController();
    const task = new ShellTask({}, {
      command: nodeCommand("process.stdout.write('partial')"),
      signal: controller.signal,
    });
    const result = await task.run();

    expect(result.success).toBe(true);
    expect((result.data as { output: string }).output).toBe('partial');
  });

  it('does not launch a command when its signal is already aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flowkit-shell-'));
    const marker = join(dir, 'launched');
    const controller = new AbortController();
    controller.abort();

    try {
      const task = new ShellTask({}, {
        command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`),
        signal: controller.signal,
      });
      const result = await task.run();

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe(SHELL_TASK_CANCELLED_MESSAGE);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cancels a running command after it closes and prevents delayed work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flowkit-shell-'));
    const marker = join(dir, 'finished');
    const controller = new AbortController();
    const { logger, captured } = makeCapturingLogger();
    let signalStarted: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const originalInfo = logger.info;
    logger.info = (...args) => {
      originalInfo(...args);
      if (
        args[0] &&
        typeof args[0] === 'object' &&
        (args[0] as { stream?: string }).stream === 'stdout' &&
        args[1] === 'started'
      ) {
        signalStarted();
      }
    };
    const task = new ShellTask({ logger }, {
      command: nodeCommand(
        `process.stdout.write('started\\n'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'), 8_000)`,
      ),
      signal: controller.signal,
    });
    try {
      const resultPromise = task.run();
      await started;
      controller.abort();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe(SHELL_TASK_CANCELLED_MESSAGE);
      expect(result.data).toMatchObject({ stderr: '' });
      expect((result.data as { stdout: string }).stdout).toContain('started');
      // Keep the delayed work sufficiently far behind the streamed readiness
      // marker. On a loaded Windows test worker, consuming stdout can lag the
      // child timer; a short delay could otherwise create the marker before
      // this test has an opportunity to issue the abort.
      await new Promise((resolve) => setTimeout(resolve, 8_500));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 25_000);

  it.runIf(process.platform !== 'win32')(
    'escalates a SIGTERM-resistant process group before delayed work runs',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'flowkit-shell-'));
      const marker = join(dir, 'survived');
      const controller = new AbortController();
      const { logger } = makeCapturingLogger();
      let signalStarted: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const originalInfo = logger.info;
      logger.info = (...args) => {
        originalInfo(...args);
        if (args[1] === 'started') signalStarted();
      };

      try {
        const resultPromise = new ShellTask({ logger }, {
          command: nodeCommand(
            `process.on('SIGTERM', () => {}); process.stdout.write('started\\n'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'), 800)`,
          ),
          signal: controller.signal,
        }).run();
        await started;
        controller.abort();

        const result = await resultPromise;
        expect(result.error?.message).toBe(SHELL_TASK_CANCELLED_MESSAGE);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await expect(access(marker)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('removes the registered abort listener exactly once after normal completion', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const task = new ShellTask({}, { command: nodeCommand(''), signal: controller.signal });

    const result = await task.run();

    expect(result.success).toBe(true);
    expectSingleListenerCleanup(addListener, removeListener);
  });

  it('removes the registered abort listener after cancellation, timeout, and spawn error', async () => {
    const scenarios = [
      {
        options: { command: nodeCommand('setTimeout(() => {}, 5_000)') },
        trigger: async (controller: AbortController) => controller.abort(),
      },
      {
        options: { command: nodeCommand('setTimeout(() => {}, 5_000)'), timeout: 10 },
        trigger: async () => undefined,
      },
      {
        options: { command: nodeCommand(''), cwd: join(tmpdir(), 'missing-flowkit-shell-cwd') },
        trigger: async () => undefined,
      },
    ];

    for (const scenario of scenarios) {
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const promise = new ShellTask({}, { ...scenario.options, signal: controller.signal }).run();
      await scenario.trigger(controller);
      const result = await promise;

      expect(result.success).toBe(false);
      expectSingleListenerCleanup(addListener, removeListener);
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  // The first two scenarios can each wait for the bounded Windows tree-kill
  // deadline, so the default Vitest deadline is not a valid aggregate bound.
  }, 15_000);

  it('cancels only the invocation that owns the signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowkit-shell-'));
    const firstCwd = join(root, 'first');
    const secondCwd = join(root, 'second');
    const controller = new AbortController();
    const source = "setTimeout(() => process.stdout.write(process.cwd() + '\\n'), 150)";

    try {
      await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);
      const cancelled = new ShellTask({}, {
        command: nodeCommand(source), cwd: firstCwd, signal: controller.signal,
      }).run();
      const successful = new ShellTask({}, { command: nodeCommand(source), cwd: secondCwd }).run();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();

      const [cancelledResult, successfulResult] = await Promise.all([cancelled, successful]);
      expect(cancelledResult.error?.message).toBe(SHELL_TASK_CANCELLED_MESSAGE);
      expect(successfulResult.success).toBe(true);
      expect((successfulResult.data as { output: string }).output).toBe(secondCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);

  it('keeps the legacy no-signal timeout result', async () => {
    const task = new ShellTask({}, {
      command: nodeCommand('setTimeout(() => {}, 1_000)'),
      timeout: 10,
    });

    const result = await task.run();

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Shell command timed out after 10ms');
  });

  it('keeps cancellation when abort wins the timeout race', async () => {
    const controller = new AbortController();
    const task = new ShellTask({}, {
      command: nodeCommand('setTimeout(() => {}, 5_000)'),
      signal: controller.signal,
      timeout: 100,
    });
    const resultPromise = task.run();
    controller.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(SHELL_TASK_CANCELLED_MESSAGE);
  });

  it('keeps timeout when it wins the abort race', async () => {
    const controller = new AbortController();
    const task = new ShellTask({}, {
      command: nodeCommand('setTimeout(() => {}, 5_000)'),
      signal: controller.signal,
      timeout: 10,
    });
    const resultPromise = task.run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Shell command timed out after 10ms');
  });

  it('requires a command option', async () => {
    const task = new ShellTask({}, { command: '' });
    const result = await task.run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/command/);
  });
});
