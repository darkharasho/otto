import { describe, it, expect, vi } from 'vitest';
import { DecisionBroker, type DecideArgs } from './decision-broker';
import type { SessionEvent } from '@shared/ipc-contract';
import type { AutonomyMode } from '@shared/messages';

function makeBroker(initialMode: AutonomyMode = 'balanced') {
  const events: SessionEvent[] = [];
  const emit = (e: SessionEvent) => events.push(e);
  const broker = new DecisionBroker(initialMode, emit);
  return { broker, events };
}

function args(overrides: Partial<DecideArgs> = {}): DecideArgs {
  return {
    sessionId: 's1',
    messageId: 'm1',
    callId: `c-${Math.random().toString(36).slice(2)}`,
    toolName: 'tool-x',
    actionClass: 'destructive',
    input: { a: 1 },
    denyPatternsFn: null,
    ...overrides,
  };
}

describe('DecisionBroker.decide', () => {
  it('returns allow immediately when matrix says allow', async () => {
    const { broker, events } = makeBroker('balanced');
    const result = await broker.decide(args({ actionClass: 'read' }));
    expect(result).toBe('allow');
    expect(events).toEqual([]);
  });

  it('returns deny synchronously and emits tool-call-denied when matrix says deny', async () => {
    const { broker, events } = makeBroker('strict');
    const result = await broker.decide(args({ actionClass: 'irreversible' }));
    expect(result).toBe('deny');
    expect(events[0]!.type).toBe('tool-call-denied');
  });

  it('returns deny synchronously when denyPatternsFn returns a reason', async () => {
    const { broker, events } = makeBroker('full-allow');
    const result = await broker.decide(
      args({ actionClass: 'read', denyPatternsFn: () => 'because reasons' })
    );
    expect(result).toBe('deny');
    const e = events[0]!;
    expect(e.type).toBe('tool-call-denied');
    if (e.type === 'tool-call-denied') expect(e.reason).toBe('because reasons');
  });

  it('emits tool-call-pending on confirm and resolves on approve', async () => {
    const { broker, events } = makeBroker('balanced');
    const p = broker.decide(args({ actionClass: 'destructive' }));
    expect(events).toHaveLength(1);
    const pending = events[0]!;
    expect(pending.type).toBe('tool-call-pending');
    if (pending.type !== 'tool-call-pending') throw new Error('unreachable');
    broker.resolve(pending.decisionId, 'approve');
    const result = await p;
    expect(result).toBe('allow');
    expect(events[events.length - 1]!.type).toBe('tool-call-decided');
  });

  it('approve-session adds to cache; subsequent same-tool calls allow without prompting', async () => {
    const { broker, events } = makeBroker('balanced');
    const a = broker.decide(args({ callId: 'a', actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve-session');
    await a;
    events.length = 0;
    const b = await broker.decide(args({ callId: 'b', actionClass: 'destructive' }));
    expect(b).toBe('allow');
    expect(events).toEqual([]);
  });

  it('approve-session does NOT bypass denylist', async () => {
    const { broker, events } = makeBroker('balanced');
    const a = broker.decide(args({ callId: 'a', actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve-session');
    await a;
    events.length = 0;
    const b = await broker.decide(
      args({ callId: 'b', actionClass: 'destructive', denyPatternsFn: () => 'no' })
    );
    expect(b).toBe('deny');
  });

  it('deny on confirm resolves the call as deny', async () => {
    const { broker, events } = makeBroker('balanced');
    const p = broker.decide(args({ actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'deny');
    const result = await p;
    expect(result).toBe('deny');
  });

  it('mode-change isolation: decision started in strict stays strict even if mode flips', async () => {
    const { broker, events } = makeBroker('strict');
    const p = broker.decide(args({ actionClass: 'reversible' }));
    broker.setMode('full-allow');
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'deny');
    const result = await p;
    expect(result).toBe('deny');
  });

  it('remote-originated reversible call requires confirm when ceiling=strict, even if desktop=full-allow', async () => {
    const events: SessionEvent[] = [];
    const broker = new DecisionBroker('full-allow', (e) => events.push(e));
    broker.setRemoteCeiling('strict');
    const p = broker.decide(args({ actionClass: 'reversible', origin: 'remote' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === 'tool-call-pending')).toBe(true);
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve');
    await p;
  });

  it('desktop-originated calls are not clamped', async () => {
    const broker = new DecisionBroker('full-allow', () => {});
    broker.setRemoteCeiling('strict');
    const outcome = await broker.decide(args({ actionClass: 'reversible', origin: 'desktop' }));
    expect(outcome).toBe('allow');
  });

  it('times out after 5 minutes and resolves as deny', async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = makeBroker('balanced');
      const p = broker.decide(args({ actionClass: 'destructive' }));
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const result = await p;
      expect(result).toBe('deny');
      const decided = events.find((e) => e.type === 'tool-call-decided');
      expect(decided).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
