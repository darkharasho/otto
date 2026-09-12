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
    denyMatchFn: null,
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

  it('returns deny synchronously when denyMatchFn returns a hard match, even in full-allow', async () => {
    const { broker, events } = makeBroker('full-allow');
    const result = await broker.decide(
      args({ actionClass: 'read', denyMatchFn: () => ({ tier: 'hard', name: 'rm-rf-root' }) })
    );
    expect(result).toBe('deny');
    const e = events[0]!;
    expect(e.type).toBe('tool-call-denied');
    if (e.type === 'tool-call-denied') expect(e.reason).toBe('rm-rf-root');
  });

  it('confirm-tier match in full-allow prompts as irreversible with catastrophic reason', async () => {
    const { broker, events } = makeBroker('full-allow');
    const p = broker.decide(
      args({ actionClass: 'destructive', denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    expect(events).toHaveLength(1);
    const pending = events[0]!;
    expect(pending.type).toBe('tool-call-pending');
    if (pending.type !== 'tool-call-pending') throw new Error('unreachable');
    expect(pending.actionClass).toBe('irreversible');
    expect(pending.reason).toContain('catastrophic=mkfs');
    broker.resolve(pending.decisionId, 'approve');
    expect(await p).toBe('allow');
  });

  it('confirm-tier match in strict is denied without prompting', async () => {
    const { broker, events } = makeBroker('strict');
    const result = await broker.decide(
      args({ denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    expect(result).toBe('deny');
    expect(events[0]!.type).toBe('tool-call-denied');
  });

  it('catastrophic pending event carries catastrophic=true; normal pending does not', async () => {
    const { broker, events } = makeBroker('full-allow');
    const p = broker.decide(
      args({ callId: 'a', denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    const pending = events[0]!;
    if (pending.type !== 'tool-call-pending') throw new Error('expected pending');
    expect(pending.catastrophic).toBe(true);
    broker.resolve(pending.decisionId, 'deny');
    await p;
    events.length = 0;
    const q = broker.decide(args({ callId: 'b', actionClass: 'irreversible' }));
    const normal = events[0]!;
    if (normal.type !== 'tool-call-pending') throw new Error('expected pending');
    expect(normal.catastrophic).toBeFalsy();
    broker.resolve(normal.decisionId, 'deny');
    await q;
  });

  it('catastrophic prompt times out to deny', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = makeBroker('full-allow');
      const p = broker.decide(
        args({ denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
      );
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(await p).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('remote resolve cannot approve a catastrophic prompt; desktop still can', async () => {
    const { broker, events } = makeBroker('full-allow');
    const p = broker.decide(
      args({ denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    const pending = events[0]!;
    if (pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve', 'remote');
    expect(events.filter((e) => e.type === 'tool-call-decided')).toHaveLength(0);
    broker.resolve(pending.decisionId, 'approve', 'desktop');
    expect(await p).toBe('allow');
  });

  it('remote resolve can deny a catastrophic prompt', async () => {
    const { broker, events } = makeBroker('full-allow');
    const p = broker.decide(
      args({ denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    const pending = events[0]!;
    if (pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'deny', 'remote');
    expect(await p).toBe('deny');
  });

  it('remote resolve can still approve a normal prompt', async () => {
    const { broker, events } = makeBroker('balanced');
    const p = broker.decide(args({ actionClass: 'destructive' }));
    const pending = events[0]!;
    if (pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve', 'remote');
    expect(await p).toBe('allow');
  });

  it('confirm-tier match in balanced is denied without prompting', async () => {
    const { broker, events } = makeBroker('balanced');
    const result = await broker.decide(
      args({ denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    expect(result).toBe('deny');
    const e = events[0]!;
    expect(e.type).toBe('tool-call-denied');
    if (e.type === 'tool-call-denied') expect(e.reason).toContain('catastrophic=mkfs');
  });

  it('confirm-tier match from remote origin is denied even in full-allow', async () => {
    const { broker, events } = makeBroker('full-allow');
    const result = await broker.decide(
      args({ origin: 'remote', denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    expect(result).toBe('deny');
    expect(events[0]!.type).toBe('tool-call-denied');
  });

  it('approve-session on a catastrophic prompt does not cache; next call prompts again', async () => {
    const { broker, events } = makeBroker('full-allow');
    const denyMatchFn = () => ({ tier: 'confirm' as const, name: 'mkfs' });
    const a = broker.decide(args({ callId: 'a', denyMatchFn }));
    const first = events.find((e) => e.type === 'tool-call-pending');
    if (!first || first.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(first.decisionId, 'approve-session');
    expect(await a).toBe('allow');
    events.length = 0;
    const b = broker.decide(args({ callId: 'b', denyMatchFn }));
    const second = events.find((e) => e.type === 'tool-call-pending');
    expect(second).toBeTruthy();
    if (!second || second.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(second.decisionId, 'deny');
    expect(await b).toBe('deny');
  });

  it('session-allow cache from a normal prompt does not bypass catastrophic confirm', async () => {
    const { broker, events } = makeBroker('full-allow');
    const a = broker.decide(args({ callId: 'a', actionClass: 'irreversible' }));
    const first = events.find((e) => e.type === 'tool-call-pending');
    if (!first || first.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(first.decisionId, 'approve-session');
    expect(await a).toBe('allow');
    events.length = 0;
    const b = broker.decide(
      args({ callId: 'b', denyMatchFn: () => ({ tier: 'confirm', name: 'mkfs' }) })
    );
    const second = events.find((e) => e.type === 'tool-call-pending');
    expect(second).toBeTruthy();
    if (!second || second.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(second.decisionId, 'deny');
    expect(await b).toBe('deny');
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

  it('approve-session does NOT bypass hard denylist', async () => {
    const { broker, events } = makeBroker('balanced');
    const a = broker.decide(args({ callId: 'a', actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve-session');
    await a;
    events.length = 0;
    const b = await broker.decide(
      args({
        callId: 'b',
        actionClass: 'destructive',
        denyMatchFn: () => ({ tier: 'hard', name: 'fork-bomb' }),
      })
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
