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

describe('SessionBus subscribeAll', () => {
  it('fires for publishes across all sessionIds with the sessionId attached', () => {
    const got: Array<{ sid: string; event: RemoteOutbound }> = [];
    bus.subscribeAll((sid, e) => got.push({ sid, event: e }));
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'a' });
    bus.publish('s2', { type: 'event', kind: 'text-delta', text: 'b' });
    expect(got).toHaveLength(2);
    expect(got[0]!.sid).toBe('s1');
    expect(got[1]!.sid).toBe('s2');
  });

  it('returned unsubscribe stops further delivery', () => {
    const got: Array<{ sid: string; event: RemoteOutbound }> = [];
    const off = bus.subscribeAll((sid, e) => got.push({ sid, event: e }));
    bus.publish('s1', { type: 'event', kind: 'x' } as RemoteOutbound);
    off();
    bus.publish('s1', { type: 'event', kind: 'y' } as RemoteOutbound);
    bus.publish('s2', { type: 'event', kind: 'z' } as RemoteOutbound);
    expect(got).toHaveLength(1);
  });

  it('coexists with per-session subscribe (both fire)', () => {
    const all: string[] = [];
    const per: string[] = [];
    bus.subscribeAll((_sid, e) => { if (e.type === 'event') all.push(String((e as { kind: string }).kind)); });
    bus.subscribe('s1', (e) => { if (e.type === 'event') per.push(String((e as { kind: string }).kind)); });
    bus.publish('s1', { type: 'event', kind: 'k1' } as RemoteOutbound);
    bus.publish('s2', { type: 'event', kind: 'k2' } as RemoteOutbound);
    expect(per).toEqual(['k1']);
    expect(all).toEqual(['k1', 'k2']);
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

describe('SessionBus byte cap', () => {
  it('drops oldest events when ring exceeds byte cap', () => {
    const bus = new SessionBus({ maxBytesPerSession: 1024 });
    for (let i = 0; i < 100; i++) {
      bus.publish('s1', { type: 'event', kind: 'noise', payload: 'x'.repeat(64) });
    }
    const { events } = bus.history('s1', 0);
    const totalBytes = events.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(1024 * 2); // generous upper bound (estimator slack)
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('SessionBus input queue', () => {
  it('serializes concurrent enqueues per session', async () => {
    const order: string[] = [];
    const runner = async (m: import('./session-bus').RemoteInbound) => {
      if (m.type === 'prompt') {
        order.push(`start:${m.text}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${m.text}`);
      }
    };
    bus.setInputHandler('s1', runner);
    await Promise.all([
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'A', origin: 'desktop' }),
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'B', origin: 'desktop' }),
    ]);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('independent sessions run in parallel', async () => {
    const events: string[] = [];
    bus.setInputHandler('s1', async () => { events.push('s1-start'); await new Promise((r) => setTimeout(r, 30)); events.push('s1-end'); });
    bus.setInputHandler('s2', async () => { events.push('s2-start'); await new Promise((r) => setTimeout(r, 10)); events.push('s2-end'); });
    await Promise.all([
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'x', origin: 'desktop' }),
      bus.enqueueInput('s2', { type: 'prompt', sessionId: 's2', text: 'y', origin: 'desktop' }),
    ]);
    expect(events.indexOf('s2-end')).toBeLessThan(events.indexOf('s1-end'));
  });
});
