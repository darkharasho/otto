import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProcessRegistry } from './process-registry';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ShellChild } from '../platform';

class FakeChild extends EventEmitter implements ShellChild {
  pid = Math.floor(Math.random() * 100_000);
  stdout = new PassThrough();
  stderr = new PassThrough();
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  private resolveExited!: (v: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  kill(_signal: NodeJS.Signals): boolean {
    return true;
  }
  constructor() {
    super();
    this.exited = new Promise((r) => (this.resolveExited = r));
  }
  finish(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.resolveExited({ exitCode, signal });
  }
}

function makeRegistry(): { registry: ProcessRegistry; events: SessionEvent[]; spawned: FakeChild[] } {
  const events: SessionEvent[] = [];
  const spawned: FakeChild[] = [];
  const factory = (_cmd: string, _cwd: string): ShellChild => {
    const c = new FakeChild();
    spawned.push(c);
    return c;
  };
  const registry = new ProcessRegistry((e) => events.push(e), factory);
  return { registry, events, spawned };
}

describe('ProcessRegistry.spawn', () => {
  it('registers a process and emits process-spawned', () => {
    const { registry, events, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'echo hi', cwd: '/tmp' });
    expect(p.handle).toBeTruthy();
    expect(p.pid).toBe(spawned[0]!.pid);
    expect(events[0]?.type).toBe('process-spawned');
  });

  it('emits process-stdout/stderr on stream data', () => {
    const { registry, events, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.stdout.write('hello');
    spawned[0]!.stderr.write('err');
    expect(events.filter((e) => e.type === 'process-stdout')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'process-stderr')).toHaveLength(1);
  });

  it('emits process-exited when the child exits', async () => {
    const { registry, events, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(0);
    await spawned[0]!.exited;
    await new Promise((r) => setImmediate(r));
    const exited = events.find((e) => e.type === 'process-exited');
    expect(exited).toBeTruthy();
    if (exited && exited.type === 'process-exited') expect(exited.exitCode).toBe(0);
  });
});

describe('ProcessRegistry.read', () => {
  it('returns buffered output and advances nextIndex', () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.stdout.write('a');
    spawned[0]!.stdout.write('b');
    const r1 = registry.read(p.handle, 0);
    expect(r1.entries.map((e) => e.data).join('')).toBe('ab');
    expect(r1.nextIndex).toBe(2);
    spawned[0]!.stdout.write('c');
    const r2 = registry.read(p.handle, r1.nextIndex);
    expect(r2.entries.map((e) => e.data).join('')).toBe('c');
    expect(r2.nextIndex).toBe(3);
  });

  it('returns status: exited after the child exits', async () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(7);
    await spawned[0]!.exited;
    await new Promise((r) => setImmediate(r));
    const r = registry.read(p.handle, 0);
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(7);
  });
});

describe('ProcessRegistry.wait', () => {
  it('resolves once the child exits', async () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    const waiter = registry.wait(p.handle);
    spawned[0]!.finish(0);
    const r = await waiter;
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('honors timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const { registry } = makeRegistry();
      const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
      const waiter = registry.wait(p.handle, 50);
      vi.advanceTimersByTime(60);
      const r = await waiter;
      expect(r.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ProcessRegistry.kill', () => {
  it('returns true and emits process-killed for a known handle', async () => {
    const { registry, events, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    const killSpy = vi.spyOn(spawned[0]!, 'kill');
    const ok = registry.kill(p.handle);
    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(events.find((e) => e.type === 'process-killed')).toBeTruthy();
  });

  it('returns false for unknown handle', () => {
    const { registry, events } = makeRegistry();
    expect(registry.kill('nope')).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('ProcessRegistry.killAll', () => {
  it('SIGTERMs every live process and resolves once they exit', async () => {
    const { registry, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'a', cwd: '/tmp' });
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'b', cwd: '/tmp' });
    const killSpies = spawned.map((c) => vi.spyOn(c, 'kill'));
    const done = registry.killAll();
    spawned[0]!.finish(0);
    spawned[1]!.finish(0);
    await done;
    expect(killSpies[0]).toHaveBeenCalledWith('SIGTERM');
    expect(killSpies[1]).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('ProcessRegistry exit eviction', () => {
  it('evicts exited processes from this.processes after the grace period', async () => {
    const now = { ms: 0 };
    const events: SessionEvent[] = [];
    const spawned: FakeChild[] = [];
    const factory = (): ShellChild => { const c = new FakeChild(); spawned.push(c); return c; };
    const registry = new ProcessRegistry((e) => events.push(e), factory, { now: () => now.ms, graceMs: 1000 });

    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(0);
    await spawned[0]!.exited;
    // After exit, entry is still queryable during the grace period.
    expect(registry.get(p.handle)).toBeDefined();
    // Advance past grace and sweep.
    now.ms = 2000;
    registry.sweep();
    expect(registry.get(p.handle)).toBeUndefined();
  });
});
