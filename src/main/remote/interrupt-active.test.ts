import { describe, it, expect } from 'vitest';
import { interruptAllAndWait } from './interrupt-active';

function fake(opts: { clears: boolean }) {
  const active = new Set(['a', 'b']);
  const interrupted: string[] = [];
  return {
    interrupted,
    activeTurnSessionIds: () => [...active],
    hasActiveTurn: () => active.size > 0,
    interrupt: async ({ sessionId }: { sessionId: string }) => {
      interrupted.push(sessionId);
      if (opts.clears) setTimeout(() => active.delete(sessionId), 20);
    },
  };
}

describe('interruptAllAndWait', () => {
  it('interrupts every active session and resolves once all finalize', async () => {
    const t = fake({ clears: true });
    await interruptAllAndWait(t, 1000, 10);
    expect(t.interrupted).toEqual(['a', 'b']);
  });
  it('throws when a turn is still active after the timeout', async () => {
    const t = fake({ clears: false });
    await expect(interruptAllAndWait(t, 60, 10)).rejects.toThrow('could not interrupt active turn');
  });
});

describe('interruptAllAndWait onInterrupt', () => {
  it('calls onInterrupt for every session it interrupts', async () => {
    const t = fake({ clears: true });
    const seen: string[] = [];
    await interruptAllAndWait(t, 1000, 10, (sid) => seen.push(sid));
    expect(seen).toEqual(['a', 'b']);
  });
});
