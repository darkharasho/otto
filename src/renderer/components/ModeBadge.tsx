import { useState } from 'react';
import type { AutonomyMode } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  mode: AutonomyMode;
}

const DOT_BY_MODE: Record<AutonomyMode, string> = {
  strict: 'bg-danger',
  balanced: 'bg-amber-500',
  'full-allow': 'bg-emerald-500',
};

const DESCRIPTIONS: Record<AutonomyMode, string> = {
  strict: 'Confirm anything mutating; deny irreversible.',
  balanced: 'Confirm destructive; deny irreversible.',
  'full-allow': 'Allow everything; confirm only irreversible.',
};

export function ModeBadge({ mode }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async (next: AutonomyMode) => {
    setOpen(false);
    if (next === mode) return;
    setBusy(true);
    try {
      await ipc.invoke('autonomy.setMode', { mode: next });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-border bg-white/[0.04] hover:bg-surface/60 disabled:opacity-50"
      >
        <span className={`inline-block w-2 h-2 rounded-full ${DOT_BY_MODE[mode]}`} />
        <span>{mode}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border border-border bg-surface shadow-xl z-10">
          {(['strict', 'balanced', 'full-allow'] as AutonomyMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => choose(m)}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-bg/40 ${
                m === mode ? 'bg-accent/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${DOT_BY_MODE[m]}`} />
                <span className="font-medium">{m}</span>
              </div>
              <div className="text-[10px] text-muted mt-0.5">{DESCRIPTIONS[m]}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
