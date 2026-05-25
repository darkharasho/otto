import { describe, it, expect, beforeEach } from 'vitest';
import { SessionBus, type RemoteOutbound } from './session-bus';

let bus: SessionBus;
let clock: { t: number };
beforeEach(() => {
  clock = { t: 1000 };
  bus = new SessionBus({ ringSize: 5, now: () => clock.t });
});

describe('SessionBus broadcast', () => {
  it('delivers events to every subscriber', () => {
    const a: RemoteOutbound[] = [];
    const b: RemoteOutbound[] = [];
    bus.subscribe('s1', (e) => a.push(e));
    bus.subscribe('s1', (e) => b.push(e));
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops further delivery', () => {
    const a: RemoteOutbound[] = [];
    const off = bus.subscribe('s1', (e) => a.push(e));
    off();
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(0);
  });

  it('does not leak events across sessions', () => {
    const a: RemoteOutbound[] = [];
    bus.subscribe('s1', (e) => a.push(e));
    bus.publish('s2', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(0);
  });
});

describe('SessionBus ring/history', () => {
  it('history returns events newer than sinceSeq', () => {
    bus.publish('s1', { type: 'event', kind: 'a' } as RemoteOutbound);
    bus.publish('s1', { type: 'event', kind: 'b' } as RemoteOutbound);
    bus.publish('s1', { type: 'event', kind: 'c' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(truncated).toBe(false);
  });

  it('history marks truncated when sinceSeq is older than the ring', () => {
    // ringSize is 5 in beforeEach
    for (let i = 0; i < 10; i++) bus.publish('s1', { type: 'event', kind: 'x' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(truncated).toBe(true);
    expect(events).toHaveLength(5);
    expect(events[0]!.seq).toBe(6);
  });

  it('history with sinceSeq equal to latest returns empty, not truncated', () => {
    bus.publish('s1', { type: 'event', kind: 'a' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(events).toEqual([]);
    expect(truncated).toBe(false);
  });
});
