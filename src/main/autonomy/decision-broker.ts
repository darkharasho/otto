import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ActionClass, AutonomyMode } from '@shared/messages';
import type { DenyMatch } from '../shell/command-class';
import { clamp, evaluate, type Decision, type RemoteCeiling } from './policy';

export interface DecideArgs {
  sessionId: string;
  messageId: string;
  callId: string;
  toolName: string;
  actionClass: ActionClass;
  input: unknown;
  denyMatchFn: ((input: unknown) => DenyMatch | null) | null;
  origin?: 'desktop' | 'remote';
}

type UserChoice = 'approve' | 'approve-session' | 'deny';

interface Pending {
  resolver: (outcome: 'allow' | 'deny') => void;
  toolName: string;
  sessionId: string;
  messageId: string;
  callId: string;
  timer: NodeJS.Timeout;
  catastrophic: boolean;
}

const DECISION_TIMEOUT_MS = 5 * 60 * 1000;

export class DecisionBroker {
  private mode: AutonomyMode;
  private remoteCeiling: RemoteCeiling = 'match';
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllow = new Set<string>();

  constructor(initialMode: AutonomyMode, private readonly emit: (e: SessionEvent) => void) {
    this.mode = initialMode;
  }

  setMode(mode: AutonomyMode): void {
    this.mode = mode;
  }

  setRemoteCeiling(c: RemoteCeiling): void {
    this.remoteCeiling = c;
  }

  async decide(args: DecideArgs): Promise<'allow' | 'deny'> {
    const match = args.denyMatchFn ? args.denyMatchFn(args.input) : null;
    if (match?.tier === 'hard') {
      this.emitDenied(args, match.name);
      return 'deny';
    }
    const catastrophic = match !== null;
    if (catastrophic && (args.origin ?? 'desktop') === 'remote') {
      // Approving a disk-wrecking command requires being at the machine.
      this.emitDenied(args, `catastrophic=${match.name}, origin=remote`);
      return 'deny';
    }
    // Catastrophic calls skip the session-allow cache: every one prompts.
    const actionClass: ActionClass = catastrophic ? 'irreversible' : args.actionClass;

    const cacheKey = `${args.sessionId}::${args.toolName}`;
    if (!catastrophic && this.sessionAllow.has(cacheKey)) return 'allow';

    const effectiveMode = (args.origin ?? 'desktop') === 'remote'
      ? clamp(this.mode, this.remoteCeiling)
      : this.mode;
    const policyOutcome: Decision = evaluate(effectiveMode, actionClass);
    const reason = catastrophic
      ? `catastrophic=${match.name}, mode=${effectiveMode}`
      : `mode=${effectiveMode}, class=${actionClass}`;
    if (policyOutcome === 'allow') return 'allow';
    if (policyOutcome === 'deny') {
      this.emitDenied(args, reason);
      return 'deny';
    }

    const decisionId = randomUUID();

    return new Promise<'allow' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(decisionId);
        if (!entry) return;
        this.pending.delete(decisionId);
        this.emit({
          type: 'tool-call-decided',
          sessionId: args.sessionId,
          messageId: args.messageId,
          callId: args.callId,
          decisionId,
          decision: 'deny',
        });
        entry.resolver('deny');
      }, DECISION_TIMEOUT_MS);

      this.pending.set(decisionId, {
        resolver: resolve,
        toolName: args.toolName,
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        timer,
        catastrophic,
      });

      this.emit({
        type: 'tool-call-pending',
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        decisionId,
        name: args.toolName,
        input: args.input,
        actionClass,
        reason,
        catastrophic,
      });
    });
  }

  resolve(decisionId: string, choice: UserChoice, source: 'desktop' | 'remote' = 'desktop'): void {
    const entry = this.pending.get(decisionId);
    if (!entry) return;
    // Approving a catastrophic command requires being at the machine; a remote
    // client may only deny. Leave the decision pending for the desktop.
    if (entry.catastrophic && source === 'remote' && choice !== 'deny') return;
    this.pending.delete(decisionId);
    clearTimeout(entry.timer);

    // A catastrophic approval is one-time only; never whitelist the tool from it.
    if (choice === 'approve-session' && !entry.catastrophic) {
      this.sessionAllow.add(`${entry.sessionId}::${entry.toolName}`);
    }

    this.emit({
      type: 'tool-call-decided',
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      callId: entry.callId,
      decisionId,
      decision: choice,
    });

    entry.resolver(choice === 'deny' ? 'deny' : 'allow');
  }

  private emitDenied(args: DecideArgs, reason: string): void {
    this.emit({
      type: 'tool-call-denied',
      sessionId: args.sessionId,
      messageId: args.messageId,
      callId: args.callId,
      name: args.toolName,
      input: args.input,
      reason,
    });
  }
}
