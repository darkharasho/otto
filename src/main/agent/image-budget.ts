/**
 * Per-session budget for images sent to the API. The SDK child process keeps
 * the full conversation history in memory and resends it every turn, so each
 * screenshot's base64 stays resident AND is re-uploaded on every subsequent
 * turn — memory and token cost both compound with conversation length. Once
 * a session crosses the budget, `session.ensureForSubmit` rolls the next
 * user message into a fresh conversation (same pattern as the idle-timeout
 * and topic-shift rollovers).
 */

export const IMAGE_BUDGET = 60;

const counts = new Map<string, number>();

export function noteImagesSent(sessionId: string, n: number): void {
  if (n <= 0) return;
  counts.set(sessionId, (counts.get(sessionId) ?? 0) + n);
}

export function imagesSent(sessionId: string): number {
  return counts.get(sessionId) ?? 0;
}

export function overImageBudget(sessionId: string): boolean {
  return imagesSent(sessionId) >= IMAGE_BUDGET;
}

export function clearImageBudget(sessionId: string): void {
  counts.delete(sessionId);
}
