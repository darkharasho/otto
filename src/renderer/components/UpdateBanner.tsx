import { useEffect, useState } from 'react';
import { ipc } from '../ipc';
import type { UpdaterBridge, UpdaterState } from '@shared/ipc-contract';

const DISMISS_KEY = 'otto.update-dismissed';

/**
 * Slim strip shown when an update has been downloaded and is waiting for a
 * restart. Downloads happen automatically in the main process, and a
 * dismissed update still installs on the next quit, so this is the only
 * update decision the user is ever asked to make.
 */
export function UpdateBanner({
  updater = ipc.updater,
  className,
}: {
  updater?: UpdaterBridge;
  className?: string;
}) {
  const [state, setState] = useState<UpdaterState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem(DISMISS_KEY),
  );

  useEffect(() => {
    void updater.status().then(setState);
    return updater.onStateChange(setState);
  }, [updater]);

  if (state.kind !== 'downloaded' || state.version === dismissed) return null;

  return (
    <div
      role="status"
      aria-label="Update ready"
      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-accent/40 bg-surface/80 text-xs ${className ?? ''}`}
    >
      <div className="text-sm text-text">Otto v{state.version} is ready.</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void updater.install()}
          className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
        >
          Restart to update
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, state.version);
            setDismissed(state.version);
          }}
          className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
        >
          Later
        </button>
      </div>
    </div>
  );
}
