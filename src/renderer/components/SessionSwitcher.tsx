import { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '@shared/messages';

interface Props {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelect(id: string): void;
  onNew(): void;
}

export function SessionSwitcher({ sessions, activeSessionId, onSelect, onNew }: Props) {
  const [open, setOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeSessionId);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside / Esc to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-text px-2 py-1 rounded-md hover:bg-surface/60"
      >
        <span className="truncate max-w-[200px]">{active?.title?.slice(0, 30) ?? 'Otto'}</span>
        <svg
          viewBox="0 0 24 24"
          className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="otto-dropdown-enter absolute left-0 top-full mt-1.5 w-72 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface shadow-2xl z-10 p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
            className="w-full flex items-center gap-2 text-left px-2.5 py-2 text-sm rounded-lg hover:bg-bg/60 text-text"
          >
            <span className="flex items-center justify-center w-5 h-5 rounded-md bg-accent/15 text-accent">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            New session
          </button>
          {sessions.length > 0 && <div className="my-1 border-t border-border/60" />}
          {sessions.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">No past sessions</div>
          )}
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSelect(s.id);
                }}
                className={[
                  'relative w-full text-left pl-3 pr-2.5 py-2 text-sm rounded-lg transition-colors',
                  isActive ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg/60',
                ].join(' ')}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />
                )}
                <div className="truncate">{s.title ?? '(untitled)'}</div>
                <div className="text-[10px] text-muted">{relativeTime(s.lastActive)}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
