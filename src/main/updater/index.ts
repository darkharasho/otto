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

export function createUpdater(_deps: UpdaterDeps): UpdaterApi {
  throw new Error('not implemented');
}
