export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export interface UpdaterApi {
  getState(): UpdaterState;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
  dispose(): void;
}

export interface UpdaterDeps {
  autoUpdater: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(): void;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
  };
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  onStateChange?: (state: UpdaterState) => void;
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;

export function createUpdater(deps: UpdaterDeps): UpdaterApi {
  let state: UpdaterState = { kind: 'idle' };
  let pendingCheck: { resolve: () => void } | null = null;
  let pendingDownload: { resolve: () => void } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // We manage the lifecycle ourselves — disable electron-updater's auto-mode
  // for downloads but keep auto-install on quit (matches our UX promise).
  deps.autoUpdater.autoDownload = false;
  deps.autoUpdater.autoInstallOnAppQuit = true;

  function setState(next: UpdaterState) {
    state = next;
    deps.onStateChange?.(state);
  }

  deps.autoUpdater.on('update-available', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'unknown';
    setState({ kind: 'available', version });
    pendingCheck?.resolve();
    pendingCheck = null;
  });

  deps.autoUpdater.on('update-not-available', () => {
    setState({ kind: 'up-to-date' });
    pendingCheck?.resolve();
    pendingCheck = null;
  });

  deps.autoUpdater.on('download-progress', (info: unknown) => {
    const percent = (info as { percent?: number })?.percent ?? 0;
    const version = state.kind === 'available' || state.kind === 'downloading'
      ? state.version
      : 'unknown';
    setState({ kind: 'downloading', version, percent });
  });

  deps.autoUpdater.on('update-downloaded', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'unknown';
    setState({ kind: 'downloaded', version });
    pendingDownload?.resolve();
    pendingDownload = null;
  });

  deps.autoUpdater.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setState({ kind: 'error', message });
    pendingCheck?.resolve();
    pendingCheck = null;
    pendingDownload?.resolve();
    pendingDownload = null;
  });

  function check(): Promise<void> {
    setState({ kind: 'checking' });
    return new Promise((resolve) => {
      pendingCheck = { resolve };
      deps.autoUpdater.checkForUpdates()
        .then(() => {
          // If no event has resolved the promise yet, resolve now so callers
          // are not blocked when the mock returns without firing an event.
          if (pendingCheck) {
            pendingCheck = null;
            resolve();
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message });
          pendingCheck = null;
          resolve();
        });
    });
  }

  function download(): Promise<void> {
    if (state.kind !== 'available' && state.kind !== 'error') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      pendingDownload = { resolve };
      deps.autoUpdater.downloadUpdate()
        .then(() => {
          // If no event has resolved the promise yet, resolve now so callers
          // are not blocked when the mock returns without firing an event.
          if (pendingDownload) {
            pendingDownload = null;
            resolve();
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message });
          pendingDownload = null;
          resolve();
        });
    });
  }

  function install() {
    if (state.kind === 'downloaded') {
      deps.autoUpdater.quitAndInstall();
    }
  }

  timer = deps.setInterval(() => { void check(); }, FOUR_HOURS);

  return {
    getState: () => state,
    check,
    download,
    install,
    dispose: () => { if (timer !== null) deps.clearInterval(timer); },
  };
}
