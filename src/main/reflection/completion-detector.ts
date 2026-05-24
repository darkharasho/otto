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
  fired: boolean;
  sinceSeq: number;
}

export class CompletionDetector {
  private readonly state = new Map<string, SessionState>();

  constructor(private readonly opts: DetectorOpts) {}

  onDone(sessionId: string): void {
    const s = this.get(sessionId);
    if (s.fired) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      this.fire(sessionId);
    }, this.opts.idleMs);
  }

  onUserActive(sessionId: string): void {
    const s = this.get(sessionId);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    s.fired = false;
  }

  onMarkComplete(sessionId: string): void {
    const s = this.get(sessionId);
    if (s.fired) return;
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
    s.fired = true;
    this.opts.onTrigger({ sessionId, sinceSeq: s.sinceSeq });
  }

  private get(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { timer: null, fired: false, sinceSeq: -1 };
      this.state.set(sessionId, s);
    }
    return s;
  }
}
