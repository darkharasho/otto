import type { AutonomyEvent, IpcChannel, OttoBridge, SessionEvent } from '@shared/ipc-contract';

export const ipc: OttoBridge = {
  invoke: ((channel: IpcChannel, args: unknown) =>
    (window.otto.invoke as unknown as (c: string, a: unknown) => Promise<unknown>)(
      channel,
      args
    )) as OttoBridge['invoke'],
  onSessionEvent(handler: (e: SessionEvent) => void): () => void {
    return window.otto.onSessionEvent(handler);
  },
  onAutonomyEvent(handler: (e: AutonomyEvent) => void): () => void {
    return window.otto.onAutonomyEvent(handler);
  },
  updater: window.otto.updater,
};
