// src/renderer-shared/tool-cards/NotebookCard.tsx
import type { ResultView } from '@shared/tool-presenters';
import { useHighlighted } from './useShiki';

type View = Extract<ResultView, { kind: 'notebook' }>;

export function NotebookCard({ view, compact }: { view: View; compact?: boolean }) {
  const html = useHighlighted(view.text, view.language ?? 'python');
  const fname = view.path.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
        <span className="text-[9px] uppercase tracking-wide">notebook</span>
        <b className="text-fg">{fname}</b>
        {view.cellIndex !== undefined && <span>cell [{view.cellIndex}]</span>}
        <span className="ml-auto text-[9px] uppercase">{view.op ?? 'replace'}</span>
      </div>
      {html
        ? <div className={`shiki-host ${fs}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={`bg-bg/80 p-2.5 m-0 font-mono ${fs} overflow-x-auto`}>{view.text}</pre>}
    </div>
  );
}
