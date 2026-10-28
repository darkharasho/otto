import { logger } from '../logger';
import { interruptAllAndWait, type InterruptTarget } from './interrupt-active';
import type { RemoteOutbound } from './session-bus';

export interface DelegationStartDeps {
  sessions: InterruptTarget & {
    start(args: { resume?: string }): Promise<{ sessionId: string }>;
    send(args: { sessionId: string; text: string; origin: 'remote' }): Promise<void>;
  };
  /** Stops the outbound delegations of a local session being interrupted. */
  interruptDelegations: (sessionId: string) => void;
  publish: (sessionId: string, event: RemoteOutbound) => void;
  interruptTimeoutMs?: number;
}

export interface DelegationStarter {
  /** True from the moment a delegation is accepted until its turn is registered as active. */
  isStarting(): boolean;
  start(args: { text: string; sessionId?: string; interruptFirst: boolean }): Promise<{ sessionId: string }>;
}

export function createDelegationStarter(deps: DelegationStartDeps): DelegationStarter {
  let starting = false;
  return {
    isStarting: () => starting,
    async start({ text, sessionId, interruptFirst }) {
      if (starting) throw new Error('another task is already starting');
      starting = true;
      try {
        if (interruptFirst) {
          await interruptAllAndWait(deps.sessions, deps.interruptTimeoutMs, undefined, deps.interruptDelegations);
        }
        const started = await deps.sessions.start(sessionId ? { resume: sessionId } : {});
        const sid = started.sessionId;
        // send() registers the turn synchronously and resolves only at turn end.
        void deps.sessions.send({ sessionId: sid, text, origin: 'remote' }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`remote delegation send failed: ${message}`);
          deps.publish(sid, { type: 'event', kind: 'error', sessionId: sid, error: { message } });
          deps.publish(sid, { type: 'event', kind: 'done', sessionId: sid });
          deps.publish(sid, { type: 'error', code: 'send-failed', message, fatal: false });
        });
        return { sessionId: sid };
      } finally {
        starting = false;
      }
    },
  };
}
