import { describe, it, expect, vi } from 'vitest';
import { createDelegationStarter } from './delegation-start';
import type { RemoteOutbound } from './session-bus';

function fakeSessions(opts: { sendFails?: boolean } = {}) {
  const active = new Set<string>(['busy']);
  let releaseInterrupt!: () => void;
  const interruptGate = new Promise<void>((r) => { releaseInterrupt = r; });
  return {
    active,
    releaseInterrupt,
    activeTurnSessionIds: () => [...active],
    hasActiveTurn: (sid?: string) => (sid ? active.has(sid) : active.size > 0),
    interrupt: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      await interruptGate;
      active.delete(sessionId);
    }),
    start: vi.fn(async (a: { resume?: string }) => ({ sessionId: a.resume ?? 'new-1' })),
    send: vi.fn((a: { sessionId: string }) => {
      active.add(a.sessionId);
      return opts.sendFails ? Promise.reject(new Error('sdk exploded')) : new Promise<void>(() => {});
    }),
  };
}

describe('createDelegationStarter', () => {
  it('reports starting during the interrupt-first window and clears once the turn is registered', async () => {
    const sessions = fakeSessions();
    const interruptDelegations = vi.fn();
    const starter = createDelegationStarter({ sessions, interruptDelegations, publish: () => {} });
    const p = starter.start({ text: 't', interruptFirst: true });
    // The interrupted turn is gone but the new one is not yet registered.
    expect(starter.isStarting()).toBe(true);
    sessions.releaseInterrupt();
    await expect(p).resolves.toEqual({ sessionId: 'new-1' });
    expect(starter.isStarting()).toBe(false);
    expect(sessions.hasActiveTurn('new-1')).toBe(true);
    expect(interruptDelegations).toHaveBeenCalledWith('busy');
  });

  it('rejects a second start while one is starting', async () => {
    const sessions = fakeSessions();
    const starter = createDelegationStarter({ sessions, interruptDelegations: () => {}, publish: () => {} });
    const first = starter.start({ text: 'a', interruptFirst: true });
    await expect(starter.start({ text: 'b', interruptFirst: true })).rejects.toThrow(/already starting/);
    sessions.releaseInterrupt();
    await first;
    expect(sessions.send).toHaveBeenCalledTimes(1);
  });

  it('publishes an error event before done when the delegated turn fails', async () => {
    const sessions = fakeSessions({ sendFails: true });
    sessions.active.clear();
    const published: RemoteOutbound[] = [];
    const starter = createDelegationStarter({ sessions, interruptDelegations: () => {}, publish: (_sid, e) => published.push(e) });
    await starter.start({ text: 't', interruptFirst: false });
    await vi.waitFor(() => expect(published.length).toBeGreaterThanOrEqual(2));
    const kinds = published.filter((e) => e.type === 'event').map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(['error', 'done']);
    expect(published[0]).toMatchObject({ type: 'event', kind: 'error', error: { message: 'sdk exploded' } });
  });
});
