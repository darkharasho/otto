import { describe, it, expect, vi } from 'vitest';
import { SudoBroker, type SudoUnlockArgs } from './sudo-broker';
import type { SessionEvent } from '@shared/ipc-contract';

function fakeSession(opts: { unlockedFor?: string; unlock?: (pw: string) => { ok: boolean; error?: string } }) {
  let unlockedSession = opts.unlockedFor ?? null;
  return {
    isUnlocked: (sessionId: string) => unlockedSession === sessionId,
    unlock: async (sessionId: string, password: string) => {
      const res = opts.unlock ? opts.unlock(password) : { ok: true };
      if (res.ok) unlockedSession = sessionId;
      return res;
    },
  };
}

const baseArgs: SudoUnlockArgs = {
  sessionId: 's1',
  messageId: 'm1',
  callId: 'c1',
  command: 'sudo apt update',
};

function makeBroker(session: ReturnType<typeof fakeSession>) {
  const events: SessionEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broker = new SudoBroker(session as any, (e) => events.push(e), { promptTimeoutMs: 50 });
  return { broker, events };
}

describe('SudoBroker.ensureUnlocked', () => {
  it('returns true immediately if already unlocked, with no prompt', async () => {
    const { broker, events } = makeBroker(fakeSession({ unlockedFor: 's1' }));
    expect(await broker.ensureUnlocked(baseArgs)).toBe(true);
    expect(events).toEqual([]);
  });

  it('prompts, accepts a valid password, and unlocks', async () => {
    const { broker, events } = makeBroker(fakeSession({ unlock: () => ({ ok: true }) }));
    const p = broker.ensureUnlocked(baseArgs);
    // The prompt event carries a promptId we reply to.
    await vi.waitFor(() => expect(events.some((e) => e.type === 'sudo-prompt')).toBe(true));
    const promptEvt = events.find((e) => e.type === 'sudo-prompt') as Extract<SessionEvent, { type: 'sudo-prompt' }>;
    broker.resolveSudo(promptEvt.promptId, 'goodpw');
    expect(await p).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'sudo-resolved', status: 'unlocked' });
  });

  it('cancels when the renderer replies with null', async () => {
    const { broker, events } = makeBroker(fakeSession({}));
    const p = broker.ensureUnlocked(baseArgs);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'sudo-prompt')).toBe(true));
    const promptEvt = events.find((e) => e.type === 'sudo-prompt') as Extract<SessionEvent, { type: 'sudo-prompt' }>;
    broker.resolveSudo(promptEvt.promptId, null);
    expect(await p).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'sudo-resolved', status: 'cancelled' });
  });

  it('re-prompts with an error on a wrong password, then fails after max attempts', async () => {
    const { broker, events } = makeBroker(fakeSession({ unlock: () => ({ ok: false, error: 'Incorrect password' }) }));
    const p = broker.ensureUnlocked(baseArgs);
    // Answer each prompt as it arrives, three times.
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'sudo-prompt').length).toBe(i + 1));
      const evt = events.filter((e) => e.type === 'sudo-prompt').at(-1) as Extract<SessionEvent, { type: 'sudo-prompt' }>;
      broker.resolveSudo(evt.promptId, 'wrong');
    }
    expect(await p).toBe(false);
    const prompts = events.filter((e) => e.type === 'sudo-prompt') as Array<Extract<SessionEvent, { type: 'sudo-prompt' }>>;
    expect(prompts.length).toBe(3);
    expect(prompts[1]!.error).toBe('Incorrect password');
    expect(events.at(-1)).toMatchObject({ type: 'sudo-resolved', status: 'failed' });
  });

  it('times out to cancelled when the renderer never replies', async () => {
    const { broker, events } = makeBroker(fakeSession({}));
    expect(await broker.ensureUnlocked(baseArgs)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'sudo-resolved', status: 'cancelled' });
  });
});
