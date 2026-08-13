import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { ShellTask } from '../../src/task/shell-task.js';
import { WINDOWS_TERMINATION_GRACE_MS } from '../../src/task/shell-termination.js';

function processStub(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    stdout: EventEmitter & {
      setEncoding: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    stderr: EventEmitter & {
      setEncoding: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
  };
  child.pid = pid;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.unref = vi.fn();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() });
  return child;
}

describe('ShellTask spawn boundaries', () => {
  beforeEach(() => spawnMock.mockReset());

  it('does not call spawn for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new ShellTask({}, {
      command: 'would-not-run',
      signal: controller.signal,
    }).run();

    expect(result.success).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a non-AbortSignal before spawning', async () => {
    const result = await new ShellTask({}, {
      command: 'would-not-run',
      signal: {} as AbortSignal,
    }).run();

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('ShellTask "signal" must be an AbortSignal');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a structural AbortSignal lookalike before spawning', async () => {
    const fakeSignal = {
      aborted: false,
      addEventListener: () => {
        throw new Error('must never register');
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const result = await new ShellTask({}, {
      command: 'would-not-run',
      signal: fakeSignal,
    }).run();

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('ShellTask "signal" must be an AbortSignal');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('kills the spawned shell immediately when Windows taskkill fails', async () => {
    const child = processStub(101);
    const taskkill = processStub(102);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('error', new Error('taskkill unavailable'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/pid', '101', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it.runIf(process.platform === 'win32')('kills the spawned shell when taskkill throws synchronously', async () => {
    const child = processStub(201);
    spawnMock.mockReturnValueOnce(child).mockImplementationOnce(() => {
      throw new Error('taskkill launch failed');
    });
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')('defers direct shell kill when taskkill succeeds', async () => {
    const child = processStub(401);
    const taskkill = processStub(402);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')(
    'waits for taskkill completion when the root shell closes first',
    async () => {
      const child = processStub(451);
      const taskkill = processStub(452);
      spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
      const controller = new AbortController();
      let completed = false;
      const resultPromise = new ShellTask({}, {
        command: 'long-running',
        signal: controller.signal,
      }).run().then((result) => {
        completed = true;
        return result;
      });

      controller.abort();
      child.emit('close', null, 'SIGKILL');
      await Promise.resolve();
      expect(completed).toBe(false);

      taskkill.emit('close', 0);
      await expect(resultPromise).resolves.toMatchObject({ success: false });
      expect(completed).toBe(true);
      expect(taskkill.kill).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === 'win32')('uses direct shell kill when taskkill exits nonzero', async () => {
    const child = processStub(501);
    const taskkill = processStub(502);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    taskkill.emit('close', 1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(resultPromise).resolves.toMatchObject({ success: false });
  });

  it.runIf(process.platform === 'win32')('ignores taskkill failures after the shell task settles', async () => {
    const child = processStub(701);
    const taskkill = processStub(702);
    spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const controller = new AbortController();
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      signal: controller.signal,
    }).run();

    controller.abort();
    taskkill.emit('close', 0);
    child.emit('close', null, 'SIGKILL');
    await expect(resultPromise).resolves.toMatchObject({ success: false });
    taskkill.emit('error', new Error('late taskkill failure'));

    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'forces and releases a hanging taskkill at the bounded deadline',
    async () => {
      vi.useFakeTimers();
      try {
        const child = processStub(901);
        const taskkill = processStub(902);
        spawnMock.mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
        const controller = new AbortController();
        const resultPromise = new ShellTask({}, {
          command: 'long-running',
          signal: controller.signal,
        }).run();

        controller.abort();
        await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_GRACE_MS - 1);
        expect(child.kill).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(resultPromise).resolves.toMatchObject({
          success: false,
          error: expect.objectContaining({ message: 'Shell command cancelled' }),
        });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
        expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
        expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
        expect(child.unref).toHaveBeenCalledTimes(1);
        expect(taskkill.unref).toHaveBeenCalledTimes(1);

        taskkill.emit('error', new Error('late taskkill failure'));
        child.emit('error', new Error('late child failure'));
        child.emit('close', null, 'SIGKILL');
        expect(child.kill).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
    12_000,
  );

  it('settles once when timeout and abort contend and late events arrive', async () => {
    vi.useFakeTimers();
    const processKill =
      process.platform === 'win32' ? undefined : vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const child = processStub(1_001);
      const taskkill = processStub(1_002);
      const stdoutRemoveListener = vi.spyOn(child.stdout, 'removeListener');
      const stderrRemoveListener = vi.spyOn(child.stderr, 'removeListener');
      spawnMock.mockReturnValueOnce(child);
      if (process.platform === 'win32') spawnMock.mockReturnValueOnce(taskkill);
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      let completions = 0;
      const resultPromise = new ShellTask({}, {
        command: 'long-running',
        signal: controller.signal,
        timeout: 10,
      }).run().then((result) => {
        completions += 1;
        return result;
      });

      child.stdout.emit('data', 'before');
      setTimeout(() => controller.abort(), 10);
      await vi.advanceTimersByTimeAsync(10);
      child.emit('close', null, 'SIGKILL');
      if (process.platform === 'win32') {
        taskkill.emit('close', 0);
      } else {
        await vi.advanceTimersByTimeAsync(250);
      }

      const result = await resultPromise;
      expect(result.error?.message).toBe('Shell command timed out after 10ms');
      expect((result.data as { stdout: string }).stdout).toBe('before');
      expect(completions).toBe(1);
      expect(
        removeListener.mock.calls.filter(([type]) => type === 'abort'),
      ).toHaveLength(1);
      expect(
        stdoutRemoveListener.mock.calls.filter(([type]) => type === 'data'),
      ).toHaveLength(1);
      expect(
        stderrRemoveListener.mock.calls.filter(([type]) => type === 'data'),
      ).toHaveLength(1);

      child.stdout.emit('data', '-late');
      child.emit('error', new Error('late child failure'));
      child.emit('close', 0, null);
      if (process.platform === 'win32') {
        taskkill.emit('error', new Error('late helper failure'));
      }
      await Promise.resolve();
      expect(completions).toBe(1);
      expect((result.data as { stdout: string }).stdout).toBe('before');
    } finally {
      processKill?.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the legacy spawn-error data shape without a signal', async () => {
    const child = processStub(301);
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = new ShellTask({}, { command: 'invalid-cwd-command' }).run();
    child.emit('error', new Error('spawn failed'));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.data).toEqual({ exitCode: null, stderr: '', stdout: '' });
    expect(spawnMock).toHaveBeenCalledWith(
      'invalid-cwd-command',
      expect.not.objectContaining({ detached: expect.anything() }),
    );
  });

  it('settles a no-signal timeout when its kill emits error without close', async () => {
    const child = processStub(801);
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = new ShellTask({}, {
      command: 'long-running',
      timeout: 1,
    }).run();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('error', new Error('kill failed'));

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: expect.objectContaining({ message: 'kill failed' }),
      data: { exitCode: null, stderr: '', stdout: '' },
    });
  });
});
