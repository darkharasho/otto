import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ShellChild } from '../platform';

export interface OutputEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  at: number;
}

export interface RunningProcess {
  handle: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  messageId: string;
  startedAt: number;
  exitedAt: number | null;
  outputBuffer: OutputEntry[];
  outputBytes: number;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
}

export type SpawnFactory = (command: string, cwd: string) => ShellChild;

const BUFFER_CAP_BYTES = 4 * 1024 * 1024;
const KILLALL_GRACE_MS = 2_000;

export class ProcessRegistry {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly children = new Map<string, ShellChild>();
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(
    private readonly emit: (e: SessionEvent) => void,
    private readonly factory: SpawnFactory,
    opts: { now?: () => number; graceMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 5 * 60_000;
  }

  spawn(args: {
    sessionId: string;
    messageId: string;
    command: string;
    cwd: string;
  }): RunningProcess {
    this.sweep();
    const child = this.factory(args.command, args.cwd);
    const handle = randomUUID();
    const proc: RunningProcess = {
      handle,
      pid: child.pid,
      command: args.command,
      cwd: args.cwd,
      sessionId: args.sessionId,
      messageId: args.messageId,
      startedAt: Date.now(),
      exitedAt: null,
      outputBuffer: [],
      outputBytes: 0,
      status: 'running',
      exitCode: null,
      signal: null,
      truncated: false,
    };
    this.processes.set(handle, proc);
    this.children.set(handle, child);

    this.emit({
      type: 'process-spawned',
      sessionId: proc.sessionId,
      messageId: proc.messageId,
      handle,
      pid: proc.pid,
      command: proc.command,
      cwd: proc.cwd,
    });

    child.stdout.on('data', (chunk: Buffer) => this.onChunk(handle, 'stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.onChunk(handle, 'stderr', chunk));

    void child.exited.then(({ exitCode, signal }) => {
      const p = this.processes.get(handle);
      if (!p) return;
      if (p.status !== 'killed') p.status = 'exited';
      p.exitCode = exitCode;
      p.signal = signal;
      this.emit({
        type: 'process-exited',
        sessionId: p.sessionId,
        messageId: p.messageId,
        handle,
        exitCode,
        signal: signal ?? null,
      });
      this.children.delete(handle);
      const proc = this.processes.get(handle);
      if (proc) proc.exitedAt = this.now();
    });

    return proc;
  }

  read(handle: string, sinceIndex = 0): {
    entries: OutputEntry[];
    nextIndex: number;
    status: 'running' | 'exited' | 'killed';
    exitCode: number | null;
  } {
    const p = this.processes.get(handle);
    if (!p) {
      return { entries: [], nextIndex: 0, status: 'exited', exitCode: null };
    }
    const entries = p.outputBuffer.filter((e) => e.at >= sinceIndex);
    const nextIndex = p.outputBuffer.length;
    return { entries, nextIndex, status: p.status, exitCode: p.exitCode };
  }

  async wait(
    handle: string,
    timeoutMs?: number
  ): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }> {
    const p = this.processes.get(handle);
    if (!p) return { exitCode: null, signal: null, timedOut: false };
    const child = this.children.get(handle);
    if (!child) {
      return { exitCode: p.exitCode, signal: p.signal ?? null, timedOut: false };
    }
    if (timeoutMs === undefined) {
      const r = await child.exited;
      return { exitCode: r.exitCode, signal: r.signal ?? null, timedOut: false };
    }
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([
      child.exited.then((r) => ({ kind: 'exit' as const, r })),
      timeout.then(() => ({ kind: 'timeout' as const })),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result.kind === 'exit') {
      return { exitCode: result.r.exitCode, signal: result.r.signal ?? null, timedOut: false };
    }
    return { exitCode: null, signal: null, timedOut: true };
  }

  kill(handle: string): boolean {
    const p = this.processes.get(handle);
    const child = this.children.get(handle);
    if (!p || !child) return false;
    p.status = 'killed';
    child.kill('SIGTERM');
    this.emit({
      type: 'process-killed',
      sessionId: p.sessionId,
      messageId: p.messageId,
      handle,
    });
    return true;
  }

  async killAll(): Promise<void> {
    const handles = [...this.children.keys()];
    for (const h of handles) this.kill(h);
    const childExits = handles
      .map((h) => this.children.get(h)?.exited)
      .filter((x): x is Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> => !!x);
    const allExited = Promise.all(childExits);
    await Promise.race([
      allExited,
      new Promise((resolve) => setTimeout(resolve, KILLALL_GRACE_MS)),
    ]);
    for (const h of handles) {
      const c = this.children.get(h);
      if (c) c.kill('SIGKILL');
    }
  }

  get(handle: string): RunningProcess | undefined {
    return this.processes.get(handle);
  }

  sweep(): void {
    const cutoff = this.now() - this.graceMs;
    for (const [handle, proc] of this.processes) {
      if (proc.exitedAt !== null && proc.exitedAt < cutoff) {
        this.processes.delete(handle);
      }
    }
  }

  private onChunk(handle: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const p = this.processes.get(handle);
    if (!p) return;
    const data = chunk.toString('utf8');
    p.outputBytes += data.length;
    while (p.outputBytes > BUFFER_CAP_BYTES && p.outputBuffer.length > 0) {
      const dropped = p.outputBuffer.shift()!;
      p.outputBytes -= dropped.data.length;
      p.truncated = true;
    }
    p.outputBuffer.push({ stream, data, at: 0 });
    p.outputBuffer.forEach((e, i) => (e.at = i));
    this.emit({
      type: stream === 'stdout' ? 'process-stdout' : 'process-stderr',
      sessionId: p.sessionId,
      messageId: p.messageId,
      handle,
      data,
    });
  }
}
