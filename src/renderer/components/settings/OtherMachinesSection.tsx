import { useEffect, useState } from 'react';
import { ipc } from '../../ipc';
import { SubsectionPage } from './SubsectionPage';

interface Machine {
  id: string;
  name: string;
  baseUrl: string;
  pairedAt: number;
  online: boolean;
}

const REFRESH_MS = 10_000;

function hostLabel(link: string): string {
  try {
    return new URL(link.trim()).hostname.split('.')[0] ?? '';
  } catch {
    return '';
  }
}

/** Electron prefixes handler errors with "Error invoking remote method '<channel>': Error: ". */
function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

const inputClass =
  'w-full px-2 py-1 text-sm rounded-md bg-bg/60 border border-border text-text outline-none focus:border-accent/70';

export function OtherMachinesSection() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  async function refresh() {
    try {
      setMachines(await ipc.invoke('peers:list', undefined));
    } catch {
      // keep the last known list
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  function onLinkChange(v: string) {
    setLink(v);
    if (!nameEdited) setName(hostLabel(v));
  }

  async function onAdd() {
    setBusy(true);
    setErr(null);
    try {
      await ipc.invoke('peers:add', { name: name.trim(), pairingUrl: link.trim() });
      setLink('');
      setName('');
      setNameEdited(false);
      setAdded(true);
      await refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function onForget(m: Machine) {
    if (!confirm(`Forget "${m.name}"? You'll need a new pairing link to add it again.`)) return;
    await ipc.invoke('peers:remove', { id: m.id });
    await refresh();
  }

  const canAdd = !busy && name.trim() !== '' && link.trim() !== '';

  return (
    <SubsectionPage
      title="Other machines"
      description="Pair other computers running Otto so this Otto can hand them tasks."
    >
      <div className="py-3 border-b border-border/40">
        <div className="text-sm font-medium text-text">Paired machines</div>
        <div className="text-[11px] text-muted mt-0.5 mb-2">
          {machines.length === 0 ? 'No machines paired yet.' : `${machines.length} paired.`}
        </div>
        {machines.length > 0 && (
          <ul className="space-y-1">
            {machines.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-2 py-2 px-2 rounded-md hover:bg-bg/40"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    role="img"
                    aria-label={m.online ? 'online' : 'offline'}
                    className={['w-2 h-2 rounded-full shrink-0', m.online ? 'bg-good' : 'bg-muted/50'].join(' ')}
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-text truncate">{m.name}</div>
                    <div className="text-[11px] text-muted truncate">{m.baseUrl}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onForget(m)}
                  className="text-xs text-danger hover:underline"
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
        {added && (
          <div className="text-[11px] text-muted mt-2">Start a new conversation (/n) to use it.</div>
        )}
      </div>

      <div className="py-3">
        <div className="text-sm font-medium text-text mb-2">Add machine</div>
        <label className="block mb-2">
          <span className="text-xs text-text">Pairing link</span>
          <div className="text-[11px] text-muted mt-0.5 mb-1">
            On the other machine: Settings → Mobile remote → Pair a device, then copy the link
          </div>
          <input
            type="text"
            value={link}
            onChange={(e) => onLinkChange(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block mb-3">
          <span className="text-xs text-text">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            className={`${inputClass} mt-1`}
          />
        </label>
        {err && <div className="text-xs text-danger mb-2">{err}</div>}
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={!canAdd}
          className={[
            'px-3 py-1.5 text-xs rounded-md border transition-colors',
            canAdd
              ? 'bg-accent/10 border-accent/40 text-text hover:bg-accent/20'
              : 'bg-bg/40 border-border text-muted cursor-not-allowed',
          ].join(' ')}
        >
          {busy ? 'Adding…' : 'Add machine'}
        </button>
      </div>
    </SubsectionPage>
  );
}
