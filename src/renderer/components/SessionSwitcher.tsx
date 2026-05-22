import { useState } from 'react';
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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted hover:text-text px-2 py-1 rounded hover:bg-surface/60"
      >
        {active?.title?.slice(0, 30) ?? 'Otto'} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl z-10">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-bg/40 border-b border-border"
          >
            + New session
          </button>
          {sessions.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">No past sessions</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onSelect(s.id);
              }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-bg/40 ${
                s.id === activeSessionId ? 'bg-accent/10' : ''
              }`}
            >
              <div className="truncate">{s.title ?? '(untitled)'}</div>
              <div className="text-[10px] text-muted">{new Date(s.lastActive).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
