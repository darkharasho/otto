// src/renderer-shared/tool-cards/CodeCard.tsx
import type { ResultView } from '@shared/tool-presenters';
import { useHighlighted } from './useShiki';

type View = Extract<ResultView, { kind: 'code' }>;

export function CodeCard({ view, compact }: { view: View; compact?: boolean }) {
  const html = useHighlighted(view.text, view.language);
  const fname = view.path?.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      {view.path && (
        <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
          <span className="text-[9px] uppercase tracking-wide">read</span>
          <span>{view.path.replace(fname ?? '', '')}<b className="text-fg">{fname}</b></span>
          <span className="ml-auto">{view.totalLines ?? view.text.split('\n').length} lines</span>
        </div>
      )}
      {html
        ? <div className={`shiki-host ${fs}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={`bg-bg/80 p-2.5 m-0 font-mono ${fs} overflow-x-auto`}>{view.text}</pre>}
      {view.truncated && (
        <div className="text-[10px] text-muted px-2.5 py-1 bg-surface/30">↳ truncated</div>
      )}
    </div>
  );
}
