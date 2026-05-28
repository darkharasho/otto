import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'search' }>;

function favicon(url: string): string {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
  catch { return ''; }
}
function hostname(url: string): string { try { return new URL(url).hostname; } catch { return url; } }

export function SearchCard({ view, compact }: { view: View; compact?: boolean }) {
  const visible = view.results.slice(0, compact ? 3 : 5);
  return (
    <div className="space-y-2">
      <div className="text-muted text-[10.5px]">"{view.query}"</div>
      {visible.map((r, i) => (
        <a key={i} href={r.url} target="_blank" rel="noreferrer"
           className="block hover:bg-surface/30 rounded p-1.5 -m-1.5 transition-colors">
          <div className="flex items-center gap-1.5">
            {favicon(r.url) && <img src={favicon(r.url)} alt="" className="w-3.5 h-3.5 rounded-sm" />}
            <span className="text-[10px] text-muted">{hostname(r.url)}</span>
          </div>
          <div className="text-fg text-[12px] font-medium leading-tight">{r.title}</div>
          {r.snippet && <div className="text-muted text-[11px] line-clamp-2">{r.snippet}</div>}
        </a>
      ))}
    </div>
  );
}
