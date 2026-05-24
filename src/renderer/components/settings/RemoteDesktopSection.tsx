import { useEffect, useState } from 'react';
import { ipc } from '../../ipc';
import { SubsectionPage } from './SubsectionPage';

export function RemoteDesktopSection() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [armed, setArmed] = useState(false);

  async function refresh() {
    const out = await ipc.invoke('remoteDesktop.status', undefined);
    setGranted(out.granted);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke() {
    await ipc.invoke('remoteDesktop.revoke', undefined);
    setArmed(false);
    await refresh();
  }

  return (
    <SubsectionPage
      title="Remote desktop"
      description="Otto controls the mouse via KDE's desktop portal. The first click triggers a permission dialog; access persists across launches until revoked."
    >
      <div className="text-sm text-text py-2">
        {granted === null
          ? 'Checking…'
          : granted
            ? 'Granted — Otto can control the mouse.'
            : 'Not yet requested — the dialog will appear the first time Otto needs to click.'}
      </div>
      {granted && (
        <div className="pt-2">
          {armed ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">Revoke remote desktop access?</span>
              <button
                type="button"
                onClick={revoke}
                className="px-2 py-0.5 rounded bg-danger text-white hover:bg-danger/90"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setArmed(false)}
                className="text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              className="text-xs text-danger hover:underline"
            >
              Revoke access…
            </button>
          )}
        </div>
      )}
    </SubsectionPage>
  );
}
