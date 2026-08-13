import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const POSIX_SIGTERM_GRACE_MS = 250;
export const POSIX_TERMINATION_GRACE_MS = 1_000;
// `taskkill /T /F` may take several seconds on a loaded Windows host while it
// enumerates and force-terminates a shell command tree. Keep cancellation
// bounded, but do not stop the helper early and release a surviving child.
export const WINDOWS_TERMINATION_GRACE_MS = 5_000;

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ShellTerminationDependencies {
  platform?: NodeJS.Platform;
  spawnProcess?: SpawnProcess;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ShellTerminationHandle {
  readonly platform: NodeJS.Platform;
  /** Whether the Windows tree helper has finished or failed. */
  isTreeKillComplete(): boolean;
  /** Notify ShellTask when it is safe to combine tree and root completion. */
  onTreeKillComplete(listener: () => void): void;
  /** Escalate a cooperative POSIX stop, or force the Windows root/helper. */
  escalate(): void;
  /** Release handles after the bounded terminal deadline. */
  release(): void;
  /** Stop helper ownership after the shell has closed normally. */
  dispose(): void;
}

export function terminationGraceMs(platform: NodeJS.Platform): number {
  return platform === 'win32' ? WINDOWS_TERMINATION_GRACE_MS : POSIX_TERMINATION_GRACE_MS;
}

/**
 * Start termination for one shell invocation.
 *
 * This module is deliberately internal. Passing the platform and process
 * functions as dependencies makes the policy testable on every CI platform
 * without changing ShellTask's public API or relying on global mutable state.
 */
export function beginShellTermination(
  child: ChildProcess,
  dependencies: ShellTerminationDependencies = {},
): ShellTerminationHandle {
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess = dependencies.spawnProcess ?? (spawn as SpawnProcess);
  const killProcessGroup =
    dependencies.killProcessGroup ??
    ((pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    });

  let active = true;
  let escalated = false;
  let rootForceRequested = false;
  let treeKiller: ChildProcess | undefined;
  let treeKillerFinished = false;
  let treeKillComplete = platform !== 'win32' || child.pid === undefined;
  const treeKillListeners = new Set<() => void>();

  const markTreeKillComplete = () => {
    if (treeKillComplete) return;
    treeKillComplete = true;
    for (const listener of treeKillListeners) listener();
    treeKillListeners.clear();
  };

  const killRoot = (signal: NodeJS.Signals) => {
    if (!active) return;
    if (signal === 'SIGKILL' && rootForceRequested) return;
    try {
      const sent = child.kill(signal);
      if (signal === 'SIGKILL' && sent) rootForceRequested = true;
    } catch {
      // The shell may have closed between the terminal event and this call.
    }
  };

  const killGroup = (signal: NodeJS.Signals) => {
    if (!active || child.pid === undefined) {
      killRoot(signal);
      return;
    }
    try {
      killProcessGroup(-child.pid, signal);
    } catch {
      // A missing process group or unsupported group signal falls back to the
      // direct shell. This cannot promise termination of escaped descendants.
      killRoot(signal);
    }
  };

  const stopTreeKiller = () => {
    if (!treeKiller || treeKillerFinished) return;
    // Retain an error handler because a forced helper close may race an error.
    treeKiller.once('error', () => undefined);
    try {
      treeKiller.kill('SIGKILL');
    } catch {
      // The helper may already be exiting.
    }
    try {
      treeKiller.unref();
    } catch {
      // Releasing the task result must not be defeated by an unref race.
    }
    treeKillerFinished = true;
  };

  if (platform === 'win32' && child.pid !== undefined) {
    try {
      treeKiller = spawnProcess(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      const killOnError = () => {
        if (!active) return;
        killRoot('SIGKILL');
        markTreeKillComplete();
      };
      treeKiller.once('error', killOnError);
      treeKiller.once('close', (code) => {
        if (!active) return;
        treeKillerFinished = true;
        if (code !== 0) killRoot('SIGKILL');
        markTreeKillComplete();
      });
    } catch {
      killRoot('SIGKILL');
      markTreeKillComplete();
    }
  } else {
    // Cooperative first phase. ShellTask schedules the bounded SIGKILL
    // escalation so normal commands can flush and clean up.
    killGroup('SIGTERM');
  }

  const escalate = () => {
    if (!active || escalated) return;
    escalated = true;
    if (platform === 'win32') {
      killRoot('SIGKILL');
      stopTreeKiller();
      return;
    }
    killGroup('SIGKILL');
  };

  const dispose = () => {
    if (!active) return;
    treeKillListeners.clear();
    try {
      stopTreeKiller();
    } finally {
      active = false;
    }
  };

  const release = () => {
    if (!active) return;
    treeKillListeners.clear();
    escalate();
    try {
      child.stdout?.destroy();
    } catch {
      // The stream may have closed between escalation and release.
    }
    try {
      child.stderr?.destroy();
    } catch {
      // The stream may have closed between escalation and release.
    }
    try {
      child.unref();
    } catch {
      // A bounded result still settles if Node rejects an unref race.
    }
    try {
      stopTreeKiller();
    } finally {
      active = false;
    }
  };

  return {
    platform,
    isTreeKillComplete: () => treeKillComplete,
    onTreeKillComplete: (listener) => {
      if (treeKillComplete) listener();
      else treeKillListeners.add(listener);
    },
    escalate,
    release,
    dispose,
  };
}
