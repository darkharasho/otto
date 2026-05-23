import { useEffect, useState } from 'react';
import { ipc } from '../ipc';
import { Section } from './SettingsControls';
import type { UpdaterState } from '@shared/ipc-contract';

function statusLine(state: UpdaterState): string {
  switch (state.kind) {
    case 'idle':
      return 'Up to date check not run yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return 'You are on the latest version.';
    case 'available':
      return `Version ${state.version} is available.`;
    case 'downloading':
      return `Downloading ${state.version}… ${Math.round(state.percent)}%`;
    case 'downloaded':
      return `Version ${state.version} is ready to install.`;
    case 'error':
      return `Update error: ${state.message}`;
  }
}

const BUSY_KINDS = new Set<UpdaterState['kind']>(['checking', 'downloading']);

export function UpdaterSection({ appVersion }: { appVersion: string }) {
  const [state, setState] = useState<UpdaterState>({ kind: 'idle' });

  useEffect(() => {
    // Fetch current state on mount
    void ipc.updater.status().then(setState);
    // Subscribe to live state changes
    const unsub = ipc.updater.onStateChange(setState);
    return unsub;
  }, []);

  const busy = BUSY_KINDS.has(state.kind);

  return (
    <Section title="Updates" description={`Otto v${appVersion}`}>
      <div className="space-y-2 py-1">
        <div className="text-xs text-muted">{statusLine(state)}</div>

        {state.kind === 'downloading' && (
          <div className="w-full h-1.5 rounded-full bg-bg/60 border border-border overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${Math.min(100, Math.round(state.percent))}%` }}
            />
          </div>
        )}

        {state.kind === 'error' && (
          <div className="text-xs text-danger">{state.message}</div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy}
            onClick={() => void ipc.updater.check().then(setState)}
            className="text-xs px-2.5 py-1 rounded-md bg-bg/60 border border-border text-text hover:border-accent/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Check for updates
          </button>

          {state.kind === 'available' && (
            <button
              type="button"
              onClick={() => void ipc.updater.download().then(setState)}
              className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Download
            </button>
          )}

          {state.kind === 'downloaded' && (
            <button
              type="button"
              onClick={() => void ipc.updater.install()}
              className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Install &amp; restart
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}
