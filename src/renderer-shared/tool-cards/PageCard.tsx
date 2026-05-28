import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'page' }>;

function favicon(url: string): string {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
  catch { return ''; }
}

export function PageCard({ view, compact }: { view: View; compact?: boolean }) {
  return (
    <div className="rounded border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface/40">
        {favicon(view.url) && <img src={favicon(view.url)} alt="" className="w-3.5 h-3.5 rounded-sm" />}
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
