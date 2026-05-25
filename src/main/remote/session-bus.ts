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

interface RingEntry { seq: number; event: RemoteOutbound; t: number }

export interface SessionBusOpts { ringSize?: number; now?: () => number }

export class SessionBus {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly ring = new Map<string, RingEntry[]>();
  private readonly seqs = new Map<string, number>();
  private readonly inputQueue = new Map<string, Array<RemoteInbound & { resolve: () => void }>>();
  private readonly inputRunning = new Map<string, boolean>();
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

  publish(sessionId: string, event: RemoteOutbound): void {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    const entry: RingEntry = { seq, event, t: this.now() };
    let ring = this.ring.get(sessionId);
    if (!ring) { ring = []; this.ring.set(sessionId, ring); }
    ring.push(entry);
    if (ring.length > this.ringSize) ring.shift();
    const subs = this.subs.get(sessionId);
    if (!subs) return;
    for (const s of subs) {
      try { s(event); } catch { /* a single bad subscriber must not break the others */ }
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
