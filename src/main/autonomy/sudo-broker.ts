import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { SudoSession } from '../shell/sudo-session';

export interface SudoUnlockArgs {
  sessionId: string;
  messageId: string;
  callId: string;
  command: string;
}

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * Coordinates the one-time, per-session password prompt that elevates Otto for
 * `sudo` commands. Mirrors DecisionBroker: it emits a UI event, parks a promise
 * keyed by a promptId, and resolves it when the renderer replies via
 * `autonomy.sudoPassword`. On a valid password the SudoSession is unlocked and
 * every later `sudo` command in the session runs without prompting.
 */
export class SudoBroker {
  private readonly pending = new Map<string, (password: string | null) => void>();

  constructor(
    private readonly session: SudoSession,
    private readonly emit: (e: SessionEvent) => void,
    private readonly opts: { promptTimeoutMs?: number; maxAttempts?: number } = {}
  ) {}

  isUnlocked(sessionId: string): boolean {
    return this.session.isUnlocked(sessionId);
  }

  /**
   * Ensure the session can run `sudo`. Returns true once unlocked, false if the
   * user cancelled, the prompt timed out, or all password attempts failed.
   */
  async ensureUnlocked(args: SudoUnlockArgs): Promise<boolean> {
    if (this.session.isUnlocked(args.sessionId)) return true;

    const maxAttempts = this.opts.maxAttempts ?? MAX_ATTEMPTS;
    let error: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const password = await this.prompt(args, error);
      if (password === null) {
        this.emitResolved(args, 'cancelled');
        return false;
      }
      const res = await this.session.unlock(args.sessionId, password);
      if (res.ok) {
        this.emitResolved(args, 'unlocked');
        return true;
      }
      error = res.error ?? 'sudo authentication failed';
    }
    this.emitResolved(args, 'failed');
    return false;
  }

  /** Renderer reply: a password to try, or null to cancel. */
  resolveSudo(promptId: string, password: string | null): void {
    const resolver = this.pending.get(promptId);
    if (!resolver) return;
    this.pending.delete(promptId);
    resolver(password);
  }

  private prompt(args: SudoUnlockArgs, error: string | undefined): Promise<string | null> {
    const promptId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(promptId)) resolve(null);
      }, this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();

      this.pending.set(promptId, (password) => {
        clearTimeout(timer);
        resolve(password);
      });

      this.emit({
        type: 'sudo-prompt',
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        promptId,
        command: args.command,
        error,
      });
    });
  }

  private emitResolved(args: SudoUnlockArgs, status: 'unlocked' | 'cancelled' | 'failed'): void {
    this.emit({
      type: 'sudo-resolved',
      sessionId: args.sessionId,
      messageId: args.messageId,
      callId: args.callId,
      status,
    });
  }
}
