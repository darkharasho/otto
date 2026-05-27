import { describe, expect, it, vi } from 'vitest';
import { ConversationPolicy } from './conversation-policy';

function makePolicy(opts: { now: number; idleMinutes: number }) {
  let current = opts.now;
  const policy = new ConversationPolicy({
    now: () => current,
    getIdleTimeoutMinutes: () => opts.idleMinutes,
  });
  return {
    policy,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('ConversationPolicy', () => {
  it('does not request fresh when timeout is disabled (0)', () => {
    const { policy, advance } = makePolicy({ now: 1000, idleMinutes: 0 });
    advance(10 * 60 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('requests fresh when elapsed exceeds timeout', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(61 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(true);
  });

  it('does not request fresh when elapsed is at or below timeout', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(60 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('recordActivity resets the elapsed counter', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(59 * 60 * 1000);
    policy.recordActivity();
    advance(59 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('shouldStartFresh is idempotent (does not record activity itself)', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(61 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(true);
    expect(policy.shouldStartFresh()).toBe(true);
  });
});
