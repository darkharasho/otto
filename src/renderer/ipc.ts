import type { AutonomyEvent, IpcChannel, OttoBridge, SessionEvent, UpdaterState } from '@shared/ipc-contract';

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
  updater: {
    status: () => window.otto.updater.status(),
    check: () => window.otto.updater.check(),
    download: () => window.otto.updater.download(),
    install: () => window.otto.updater.install(),
    onStateChange: (cb: (state: UpdaterState) => void) => window.otto.updater.onStateChange(cb),
  },
};
