export interface TriggerArgs {
  sessionId: string;
  sinceSeq: number;
}

export interface DetectorOpts {
  idleMs: number;
  onTrigger: (args: TriggerArgs) => void;
}

interface SessionState {
  timer: NodeJS.Timeout | null;
  /** Sequence number marking the start of the current unreflected segment. */
  sinceSeq: number;
  /** Number of assistant turns completed in the current segment. */
  turnCount: number;
}

export class CompletionDetector {
  private readonly state = new Map<string, SessionState>();

  constructor(private readonly opts: DetectorOpts) {}

  /** Called when an assistant turn finishes (the SDK yields 'done'). */
  onDone(sessionId: string): void {
    const s = this.get(sessionId);
    s.turnCount++;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      this.fire(sessionId);
    }, this.opts.idleMs);
  }

  /** Called when the user sends a new message (potential mid-conversation). */
  onUserActive(sessionId: string): void {
    const s = this.get(sessionId);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    // If enough turns have accumulated, fire a reflection for the segment
    // completed so far rather than discarding it. This ensures long
    // back-and-forth sessions still produce learnings even if the user never
    // goes idle for the full timeout.
    if (s.turnCount >= 3) {
      this.fire(sessionId);
    }
  }

  onMarkComplete(sessionId: string): void {
    const s = this.get(sessionId);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    this.fire(sessionId);
  }

  notePersistedSeq(sessionId: string, seq: number): void {
    this.get(sessionId).sinceSeq = seq;
  }

  private fire(sessionId: string): void {
    const s = this.get(sessionId);
    const sinceSeq = s.sinceSeq;
    // Reset for the next segment.
    s.turnCount = 0;
    this.opts.onTrigger({ sessionId, sinceSeq });
  }

  private get(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { timer: null, sinceSeq: -1, turnCount: 0 };
      this.state.set(sessionId, s);
    }
    return s;
  }
}
