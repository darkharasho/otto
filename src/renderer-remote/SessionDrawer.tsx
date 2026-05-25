import { useEffect, useState } from 'react';
import { listSessions, type RemoteSessionSummary } from './wire';

interface SessionDrawerProps {
  open: boolean;
  token: string;
  currentSessionId: string | null;
  onClose(): void;
  onNewSession(): void;
  onPickSession(sessionId: string): void;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

export function SessionDrawer({ open, token, currentSessionId, onClose, onNewSession, onPickSession }: SessionDrawerProps): JSX.Element {
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr(null);
    listSessions(token, 50)
      .then((r) => setSessions(r.sessions))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, token]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer panel */}
      <aside
        className={`fixed top-0 left-0 z-50 h-full w-[280px] bg-surface border-r border-border shadow-xl transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`}
        aria-hidden={!open}
      >
        <div className="flex flex-col h-full">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-sm font-semibold">Sessions</span>
            <button onClick={onClose} className="text-xs text-muted hover:text-text" aria-label="Close drawer">Close</button>
          </div>
          <div className="p-3 border-b border-border">
            <button
              onClick={onNewSession}
              className="w-full rounded-md bg-accent text-white px-3 py-2 text-sm font-medium hover:opacity-90"
            >
              + New chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && <div className="px-4 py-3 text-xs text-muted">Loading…</div>}
            {err && <div className="px-4 py-3 text-xs text-danger">{err}</div>}
            {!loading && !err && sessions.length === 0 && (
              <div className="px-4 py-3 text-xs text-muted">No sessions yet.</div>
            )}
            <ul className="py-1">
              {sessions.map((s) => {
                const isCurrent = s.id === currentSessionId;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => onPickSession(s.id)}
                      className={`w-full text-left px-4 py-2 hover:bg-bg/60 focus:bg-bg/60 outline-none ${isCurrent ? 'bg-bg/40' : ''}`}
                    >
                      <div className="text-sm truncate">
                        {s.title?.trim() || 'Untitled'}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {relativeTime(s.lastActive)}
                        {isCurrent && <span className="ml-2 text-accent">· current</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </aside>
    </>
  );
}
