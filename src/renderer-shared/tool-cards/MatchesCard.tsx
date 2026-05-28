import { useMemo, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'matches' }>;

export function MatchesCard({ view, compact }: { view: View; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limit = compact ? 8 : 20;
  const visible = showAll ? view.files : view.files.slice(0, limit);
  const grouped = useMemo(() => {
    const m = new Map<string, typeof view.files>();
    for (const f of visible) {
      const arr = m.get(f.path) ?? [];
      arr.push(f); m.set(f.path, arr);
    }
    return Array.from(m.entries());
  }, [visible]);
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className={`rounded bg-bg/60 p-2 font-mono ${fs}`}>
      <div className="flex items-center gap-2 mb-1.5 text-muted">
        <span className="text-[9px] uppercase">grep</span>
        <span className="text-fg">/{view.pattern}/</span>
        <span className="ml-auto px-1.5 py-0.5 rounded bg-surface/60 text-[10px]">
          {view.files.length} match{view.files.length === 1 ? '' : 'es'} · {grouped.length} file{grouped.length === 1 ? '' : 's'}
        </span>
      </div>
      {grouped.map(([path, rows]) => (
        <div key={path} className="mb-1.5">
          <div className="text-fg break-all"><b>{path}</b></div>
          {rows.map((r, i) => (
            <div key={i} className="pl-3 break-all">
              <span className="text-muted mr-2">L{r.line}</span>
              <span>{r.snippet}</span>
            </div>
          ))}
        </div>
      ))}
      {view.files.length > limit && (
        <button type="button" onClick={() => setShowAll(s => !s)}
                className="text-accent text-[10px] hover:underline">
          {showAll ? 'Show fewer' : `Show all ${view.files.length}`}
        </button>
      )}
    </div>
  );
}
