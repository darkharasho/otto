// src/renderer-shared/tool-cards/DiffCard.tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'diff' }>;

export function DiffCard({ view, compact }: { view: View; compact?: boolean }) {
  const fname = view.path.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
        <span className={`text-[9px] uppercase tracking-wide ${view.isNew ? 'text-accent' : 'text-amber-400'}`}>
          {view.isNew ? 'new' : 'edit'}
        </span>
        <span>{view.path.replace(fname ?? '', '')}<b className="text-fg">{fname}</b></span>
        <span className="ml-auto">
          <span className="text-accent">+{view.added}</span>{' '}
          <span className="text-danger">−{view.removed}</span>
        </span>
      </div>
      <div className={`bg-bg/80 font-mono ${fs}`}>
        {view.hunks.map((h, hi) => (
          <div key={hi}>
            {hi > 0 && <div className="text-muted px-2 py-0.5 bg-surface/20">…</div>}
            {h.lines.map((l, li) => {
              const bg = l.kind === 'add' ? 'bg-emerald-500/10 text-emerald-300'
                       : l.kind === 'del' ? 'bg-red-500/10 text-red-300' : '';
              const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
              return (
                <pre key={li} className={`m-0 whitespace-pre-wrap break-words px-2 ${bg}`}>{sign} {l.text}</pre>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
