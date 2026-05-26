import type { PlatformAdapter, ShellChild } from '../platform';

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

const OUTPUT_CAP_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = '\n[output truncated]';
const KILL_GRACE_MS = 2_000;

export async function exec(opts: ExecOptions, adapter: PlatformAdapter): Promise<ExecResult> {
  const startedAt = Date.now();
  const child = adapter.shell.spawnShell(opts.command, opts.cwd);

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const onStdout = (chunk: Buffer): void => {
    if (stdoutTruncated) return;
    const next = stdout + chunk.toString('utf8');
    if (next.length > OUTPUT_CAP_BYTES) {
      stdout = next.slice(0, OUTPUT_CAP_BYTES) + TRUNCATION_MARKER;
      stdoutTruncated = true;
    } else {
      stdout = next;
    }
  };

  const onStderr = (chunk: Buffer): void => {
    if (stderrTruncated) return;
    const next = stderr + chunk.toString('utf8');
    if (next.length > OUTPUT_CAP_BYTES) {
      stderr = next.slice(0, OUTPUT_CAP_BYTES) + TRUNCATION_MARKER;
      stderrTruncated = true;
    } else {
      stderr = next;
    }
  };

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);

  // Wait for streams to finish draining before returning. On some platforms
  // (notably macOS/zsh) the process 'exit' event fires before all pipe data
  // has been delivered, so we must wait for both 'end' events.
  const stdoutDone = new Promise<void>((r) => child.stdout.once('end', r));
  const stderrDone = new Promise<void>((r) => child.stderr.once('end', r));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }, opts.timeoutMs);

  const result = await child.exited;
  await Promise.all([stdoutDone, stderrDone]);
  clearTimeout(timer);

  const exitCode = result.exitCode ?? -1;
  return {
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}

export function spawn(command: string, cwd: string, adapter: PlatformAdapter): ShellChild {
  return adapter.shell.spawnShell(command, cwd);
}
