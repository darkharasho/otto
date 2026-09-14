import type { PlatformAdapter, ShellChild } from '../platform';

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Incremental output as it arrives (before the buffered result returns). Stops after the 1MB cap trips. */
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
  /** Receives a kill switch for the spawned child (the Stop button on a streaming card). */
  onSpawn?: (proc: { kill: () => void }) => void;
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
  opts.onSpawn?.({
    kill: () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    },
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const onStdout = (chunk: Buffer): void => {
    if (stdoutTruncated) return;
    const text = chunk.toString('utf8');
    const kept = Math.min(text.length, OUTPUT_CAP_BYTES - stdout.length);
    if (kept < text.length) {
      stdout = stdout + text.slice(0, kept) + TRUNCATION_MARKER;
      stdoutTruncated = true;
      opts.onChunk?.('stdout', text.slice(0, kept) + TRUNCATION_MARKER);
    } else {
      stdout += text;
      opts.onChunk?.('stdout', text);
    }
  };

  const onStderr = (chunk: Buffer): void => {
    if (stderrTruncated) return;
    const text = chunk.toString('utf8');
    const kept = Math.min(text.length, OUTPUT_CAP_BYTES - stderr.length);
    if (kept < text.length) {
      stderr = stderr + text.slice(0, kept) + TRUNCATION_MARKER;
      stderrTruncated = true;
      opts.onChunk?.('stderr', text.slice(0, kept) + TRUNCATION_MARKER);
    } else {
      stderr += text;
      opts.onChunk?.('stderr', text);
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
  // Give streams a short window to flush after exit. On macOS/zsh the exit
  // event fires before all pipe data is delivered, but we don't want to hang
  // indefinitely if a killed process's streams never close.
  const drainTimeout = new Promise<void>((r) => setTimeout(r, 1000));
  await Promise.race([Promise.all([stdoutDone, stderrDone]), drainTimeout]);
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
