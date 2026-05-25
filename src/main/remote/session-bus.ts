export type RemoteOutbound =
  | { type: 'event'; kind: string; [k: string]: unknown }
  | { type: 'approval_pending'; decisionId: string; tool: string; summary: string; actionClass: string; expiresAt: number }
  | { type: 'approval_resolved'; decisionId: string; decision: 'approve' | 'deny'; by: 'desktop' | 'remote' | 'timeout' }
  | { type: 'session_state'; sessionId: string; status: string; autonomyMode: string; pendingApprovals: string[] }
  | { type: 'error'; code: string; message: string; fatal: boolean };

export type RemoteInbound =
  | { type: 'prompt'; sessionId: string; text: string; origin: 'desktop' | 'remote' }
  | { type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { type: 'interrupt'; sessionId: string };

type Subscriber = (e: RemoteOutbound) => void;
type AllSubscriber = (sessionId: string, e: RemoteOutbound) => void;
type InputHandler = (m: RemoteInbound) => Promise<void>;

interface RingEntry { seq: number; event: RemoteOutbound; t: number }

export interface SessionBusOpts { ringSize?: number; now?: () => number }

export class SessionBus {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly allSubs = new Set<AllSubscriber>();
  private readonly ring = new Map<string, RingEntry[]>();
  private readonly seqs = new Map<string, number>();
  private readonly inputQueue = new Map<string, Array<RemoteInbound & { resolve: () => void }>>();
  private readonly inputRunning = new Map<string, boolean>();
  private readonly handlers = new Map<string, InputHandler>();
  private readonly ringSize: number;
  private readonly now: () => number;

  constructor(opts: SessionBusOpts = {}) {
    this.ringSize = opts.ringSize ?? 200;
    this.now = opts.now ?? Date.now;
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(sub);
    return () => { set!.delete(sub); };
  }

  /**
   * Subscribe to publishes across ALL sessions. The callback receives the
   * sessionId alongside the event. Used by the bridge WS so a phone can
   * connect before any session exists and still receive events for whatever
   * session subsequently starts (or for multiple sessions concurrently).
   */
  subscribeAll(sub: AllSubscriber): () => void {
    this.allSubs.add(sub);
    return () => { this.allSubs.delete(sub); };
  }

  publish(sessionId: string, event: RemoteOutbound): void {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    const entry: RingEntry = { seq, event, t: this.now() };
    let ring = this.ring.get(sessionId);
    if (!ring) { ring = []; this.ring.set(sessionId, ring); }
    ring.push(entry);
    if (ring.length > this.ringSize) ring.shift();
    const subs = this.subs.get(sessionId);
    if (subs) {
      for (const s of subs) {
        try { s(event); } catch { /* a single bad subscriber must not break the others */ }
      }
    }
    for (const s of this.allSubs) {
      try { s(sessionId, event); } catch { /* a single bad subscriber must not break the others */ }
    }
  }

  setInputHandler(sessionId: string, handler: InputHandler): void {
    this.handlers.set(sessionId, handler);
  }

  async enqueueInput(sessionId: string, message: RemoteInbound): Promise<void> {
    return new Promise<void>((resolve) => {
      let q = this.inputQueue.get(sessionId);
      if (!q) { q = []; this.inputQueue.set(sessionId, q); }
      q.push({ ...(message as RemoteInbound & { resolve: () => void }), resolve });
      void this.drain(sessionId);
    });
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.inputRunning.get(sessionId)) return;
    this.inputRunning.set(sessionId, true);
    try {
      const q = this.inputQueue.get(sessionId)!;
      while (q.length > 0) {
        const m = q.shift()!;
        const handler = this.handlers.get(sessionId);
        try { if (handler) await handler(m); } catch { /* surfaced via published events */ }
        m.resolve();
      }
    } finally {
      this.inputRunning.set(sessionId, false);
    }
  }

  history(sessionId: string, sinceSeq: number): { events: Array<{ seq: number; event: RemoteOutbound }>; truncated: boolean } {
    const ring = this.ring.get(sessionId) ?? [];
    if (ring.length === 0) return { events: [], truncated: false };
    const oldest = ring[0]!.seq;
    const truncated = sinceSeq + 1 < oldest;
    const events = ring.filter((e) => e.seq > sinceSeq).map((e) => ({ seq: e.seq, event: e.event }));
    return { events, truncated };
  }
}
