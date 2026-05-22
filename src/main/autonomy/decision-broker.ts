import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ActionClass, AutonomyMode } from '@shared/messages';
import { evaluate, type Decision } from './policy';

export interface DecideArgs {
  sessionId: string;
  messageId: string;
  callId: string;
  toolName: string;
  actionClass: ActionClass;
  input: unknown;
  denyPatternsFn: ((input: unknown) => string | null) | null;
}

type UserChoice = 'approve' | 'approve-session' | 'deny';

interface Pending {
  resolver: (outcome: 'allow' | 'deny') => void;
  toolName: string;
  sessionId: string;
  messageId: string;
  callId: string;
  timer: NodeJS.Timeout;
}

const DECISION_TIMEOUT_MS = 5 * 60 * 1000;

export class DecisionBroker {
  private mode: AutonomyMode;
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllow = new Set<string>();

  constructor(initialMode: AutonomyMode, private readonly emit: (e: SessionEvent) => void) {
    this.mode = initialMode;
  }

  setMode(mode: AutonomyMode): void {
    this.mode = mode;
  }

  async decide(args: DecideArgs): Promise<'allow' | 'deny'> {
    if (args.denyPatternsFn) {
      const reason = args.denyPatternsFn(args.input);
      if (reason !== null) {
        this.emitDenied(args, reason);
        return 'deny';
      }
    }

    const cacheKey = `${args.sessionId}::${args.toolName}`;
    if (this.sessionAllow.has(cacheKey)) return 'allow';

    const policyOutcome: Decision = evaluate(this.mode, args.actionClass);
    if (policyOutcome === 'allow') return 'allow';
    if (policyOutcome === 'deny') {
      this.emitDenied(args, `mode=${this.mode}, class=${args.actionClass}`);
      return 'deny';
    }

    const decisionId = randomUUID();
    const reason = `mode=${this.mode}, class=${args.actionClass}`;

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
      });

      this.emit({
        type: 'tool-call-pending',
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        decisionId,
        name: args.toolName,
        input: args.input,
        actionClass: args.actionClass,
        reason,
      });
    });
  }

  resolve(decisionId: string, choice: UserChoice): void {
    const entry = this.pending.get(decisionId);
    if (!entry) return;
    this.pending.delete(decisionId);
    clearTimeout(entry.timer);

    if (choice === 'approve-session') {
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
