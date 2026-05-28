import type { ResultView } from '@shared/tool-presenters';
import { favicon } from './url-helpers';

type View = Extract<ResultView, { kind: 'page' }>;

export function PageCard({ view, compact: _compact }: { view: View; compact?: boolean }) {
  const fav = favicon(view.url);
  return (
    <div className="rounded border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface/40">
        {fav && <img src={fav} alt="" className="w-3.5 h-3.5 rounded-sm" />}
        <a href={view.url} target="_blank" rel="noreferrer"
           className="text-[11px] truncate hover:underline">{view.url}</a>
      </div>
      <div className="p-2.5">
        {view.title && <div className="font-medium text-[12px]">{view.title}</div>}
        {view.snippet && <div className="text-muted text-[11px] mt-1 line-clamp-3">{view.snippet}</div>}
      </div>
    </div>
  );
}
