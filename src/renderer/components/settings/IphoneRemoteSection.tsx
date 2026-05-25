import { useEffect, useState } from 'react';
import { ipc } from '../../ipc';
import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';
import { PairIphoneModal } from './PairIphoneModal';
import type {
  PairedDeviceSummary,
  RemoteCeilingChoice,
  RemoteStatus,
} from '@shared/ipc-contract';

const REFRESH_MS = 5000;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusLine(status: RemoteStatus): string {
  if (status.running && status.url) {
    return `Listening on ${status.url}`;
  }
  if (!status.running) {
    const reason = status.reason ?? '';
    if (/tailnet|tailscale/i.test(reason)) {
      return 'Tailscale not detected — install/start Tailscale and toggle Remote access off/on.';
    }
    if (reason) return `Not running — ${reason}`;
    return 'Not running.';
  }
  return '';
}

export function IphoneRemoteSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<PairedDeviceSummary[]>([]);
  const [showPair, setShowPair] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      const s = await ipc.invoke('remote:getStatus', undefined);
      setStatus(s);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function refreshDevices() {
    try {
      const d = await ipc.invoke('remote:listDevices', undefined);
      setDevices(d);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void refreshStatus();
    void refreshDevices();
    const id = setInterval(() => {
      void refreshStatus();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  async function onToggleEnabled(v: boolean) {
    setStatus((cur) => (cur ? { ...cur, enabled: v } : cur));
    try {
      await ipc.invoke('remote:setEnabled', { enabled: v });
    } finally {
      await refreshStatus();
    }
  }

  async function onCeilingChange(value: RemoteCeilingChoice) {
    setStatus((cur) => (cur ? { ...cur, remoteCeiling: value } : cur));
    try {
      await ipc.invoke('remote:setRemoteCeiling', { ceiling: value });
    } finally {
      await refreshStatus();
    }
  }

  async function onRevoke(d: PairedDeviceSummary) {
    if (!confirm(`Revoke "${d.label}"? It will need to pair again to reconnect.`)) return;
    await ipc.invoke('remote:revokeDevice', { deviceId: d.id });
    await refreshDevices();
    await refreshStatus();
  }

  const pairDisabled = !status || !status.enabled;

  return (
    <SubsectionPage
      title="iPhone remote"
      description="Talk to Otto from your iPhone over your tailnet. Paired devices appear below."
    >
      <div className="text-sm text-text py-2">
        {err ? (
          <span className="text-danger">Error: {err}</span>
        ) : !status ? (
          'Checking…'
        ) : (
          statusLine(status)
        )}
      </div>

      <Toggle
        divided
        checked={!!status?.enabled}
        onChange={(v) => void onToggleEnabled(v)}
        label="Remote access"
        description="Run the local HTTPS endpoint on your tailnet."
      />

      <div className="py-3 border-b border-border/40">
        <div className="text-sm font-medium text-text">Remote autonomy ceiling</div>
        <div className="text-[11px] text-muted mt-0.5 mb-2">
          Limit how much Otto can do during turns started from your phone.
        </div>
        <select
          value={status?.remoteCeiling ?? 'match'}
          onChange={(e) => void onCeilingChange(e.target.value as RemoteCeilingChoice)}
          disabled={!status}
          className="px-2 py-1 text-sm rounded-md bg-bg/60 border border-border text-text outline-none focus:border-accent/70"
        >
          <option value="match">Match desktop autonomy mode</option>
          <option value="strict">Force Strict for remote turns</option>
        </select>
      </div>

      <div className="py-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-sm font-medium text-text">Paired devices</div>
            <div className="text-[11px] text-muted mt-0.5">
              {devices.length === 0 ? 'No devices paired yet.' : `${devices.length} paired.`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowPair(true)}
            disabled={pairDisabled}
            title={pairDisabled ? 'Enable Remote access first' : undefined}
            className={[
              'px-3 py-1.5 text-xs rounded-md border transition-colors',
              pairDisabled
                ? 'bg-bg/40 border-border text-muted cursor-not-allowed'
                : 'bg-accent/10 border-accent/40 text-text hover:bg-accent/20',
            ].join(' ')}
          >
            Pair new device
          </button>
        </div>

        {devices.length > 0 && (
          <ul className="space-y-1">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-2 py-2 px-2 rounded-md hover:bg-bg/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text truncate">{d.label}</div>
                  <div className="text-[11px] text-muted truncate">
                    paired {formatRelative(d.pairedAt)} · last seen{' '}
                    {d.lastSeenAt ? formatRelative(d.lastSeenAt) : 'never'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onRevoke(d)}
                  className="text-xs text-danger hover:underline"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showPair && (
        <PairIphoneModal
          initialDeviceCount={devices.length}
          onClose={() => {
            setShowPair(false);
            void refreshDevices();
            void refreshStatus();
          }}
          onPaired={() => {
            void refreshDevices();
            void refreshStatus();
          }}
        />
      )}
    </SubsectionPage>
  );
}
