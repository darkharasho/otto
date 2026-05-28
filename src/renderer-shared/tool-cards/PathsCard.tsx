import { useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'paths' }>;

export function PathsCard({ view, compact }: { view: View; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limit = compact ? 12 : 30;
  const visible = showAll ? view.matches : view.matches.slice(0, limit);
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className={`rounded bg-bg/60 p-2 font-mono ${fs}`}>
      {view.pattern && (
        <div className="flex items-center gap-2 mb-1.5 text-muted">
          <span className="text-[9px] uppercase">pattern</span>
          <span className="text-fg">{view.pattern}</span>
          <span className="ml-auto px-1.5 py-0.5 rounded bg-surface/60 text-[10px]">
            {view.matches.length} match{view.matches.length === 1 ? '' : 'es'}
          </span>
        </div>
      )}
      <ul className="space-y-0.5">
        {visible.map(p => <li key={p} className="break-all">{p}</li>)}
      </ul>
      {view.matches.length > limit && (
        <button type="button" onClick={() => setShowAll(s => !s)}
                className="mt-1.5 text-accent text-[10px] hover:underline">
          {showAll ? 'Show fewer' : `Show all ${view.matches.length}`}
        </button>
      )}
    </div>
  );
}
