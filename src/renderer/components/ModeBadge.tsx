import { useState } from 'react';
import { Shield, ShieldHalf, Unlock } from 'lucide-react';
import type { AutonomyMode } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  mode: AutonomyMode;
  openDirection?: 'up' | 'down';
}

const LABEL: Record<AutonomyMode, string> = {
  strict: 'Strict',
  balanced: 'Balanced',
  'full-allow': 'Full access',
};

const ICON: Record<AutonomyMode, typeof Shield> = {
  strict: Shield,
  balanced: ShieldHalf,
  'full-allow': Unlock,
};

// full-allow gets the single warm caution cue; the rest use the brand violet.
const ICON_COLOR: Record<AutonomyMode, string> = {
  strict: 'text-[#8f90e8]',
  balanced: 'text-[#8f90e8]',
  'full-allow': 'text-[#e0a23a]',
};

const DESCRIPTIONS: Record<AutonomyMode, string> = {
  strict: 'Confirm anything mutating; deny irreversible.',
  balanced: 'Confirm destructive; deny irreversible.',
  'full-allow': 'Allow everything; confirm only irreversible.',
};

export function ModeBadge({ mode, openDirection = 'up' }: Props) {
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

  const Icon = ICON[mode];
  const menuPos = openDirection === 'down' ? 'top-full mt-1' : 'bottom-full mb-1';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border border-border bg-white/[0.04] text-[#c7c9d1] hover:bg-white/[0.07] disabled:opacity-50"
      >
        <Icon className={`w-3 h-3 ${ICON_COLOR[mode]}`} aria-hidden />
        <span>{LABEL[mode]}</span>
      </button>
      {open && (
        <div className={`absolute ${menuPos} right-0 w-56 rounded-lg border border-border bg-surface shadow-xl z-10`}>
          {(['strict', 'balanced', 'full-allow'] as AutonomyMode[]).map((m) => {
            const MIcon = ICON[m];
            return (
              <button
                key={m}
                type="button"
                onClick={() => choose(m)}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-bg/40 ${m === mode ? 'bg-accent/10' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <MIcon className={`w-3 h-3 ${ICON_COLOR[m]}`} aria-hidden />
                  <span className="font-medium">{LABEL[m]}</span>
                </div>
                <div className="text-[10px] text-muted mt-0.5">{DESCRIPTIONS[m]}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
