export interface InterruptTarget {
  activeTurnSessionIds(): string[];
  hasActiveTurn(sessionId?: string): boolean;
  interrupt(args: { sessionId: string }): Promise<void>;
}

/**
 * Interrupts every session with an active turn and waits (bounded) for them to finalize. Throws if any is still active.
 * `onInterrupt` runs for each interrupted session (to stop its outbound delegations too).
 */
export async function interruptAllAndWait(
  t: InterruptTarget,
  timeoutMs = 10_000,
  pollMs = 50,
  onInterrupt?: (sessionId: string) => void,
): Promise<void> {
  await Promise.all(t.activeTurnSessionIds().map((sessionId) => {
    onInterrupt?.(sessionId);
    return t.interrupt({ sessionId });
  }));
  const deadline = Date.now() + timeoutMs;
  while (t.hasActiveTurn() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (t.hasActiveTurn()) throw new Error('could not interrupt active turn');
}
