export interface ConversationPolicyDeps {
  now(): number;
  getIdleTimeoutMinutes(): number;
}

export class ConversationPolicy {
  private lastActivityAt: number;

  constructor(private readonly deps: ConversationPolicyDeps) {
    this.lastActivityAt = deps.now();
  }

  recordActivity(): void {
    this.lastActivityAt = this.deps.now();
  }

  shouldStartFresh(): boolean {
    const minutes = this.deps.getIdleTimeoutMinutes();
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    return this.deps.now() - this.lastActivityAt > minutes * 60_000;
  }
}
