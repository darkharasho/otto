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
