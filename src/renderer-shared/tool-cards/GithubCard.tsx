import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'github' }>;

const STATE_PILL: Record<string, string> = {
  open:   'bg-emerald-500/15 text-emerald-300',
  closed: 'bg-red-500/15 text-red-300',
  merged: 'bg-purple-500/15 text-purple-300',
  draft:  'bg-zinc-500/15 text-zinc-300',
};

export function GithubCard({ view, compact: _compact }: { view: View; compact?: boolean }) {
  const pill = STATE_PILL[view.state ?? ''] ?? 'bg-surface/60 text-muted';
  return (
    <div className="rounded border border-border/50 p-2.5">
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span className="uppercase tracking-wide">github · {view.flavor}</span>
        <span>{view.repo}</span>
        {view.state && (
          <span className={`ml-auto px-2 py-0.5 rounded-full uppercase tracking-wide ${pill}`}>{view.state}</span>
        )}
      </div>
      <div className="mt-1 text-[12px]">
        {view.number !== undefined && <span className="font-mono text-muted">#{view.number} · </span>}
        <span className="font-medium">{view.title ?? '(untitled)'}</span>
      </div>
      <div className="text-muted text-[10.5px] mt-0.5">
        {view.author && <>by {view.author}</>}
        {view.stats && <> · <span className="text-accent">+{view.stats.added}</span> <span className="text-danger">−{view.stats.removed}</span> · {view.stats.files} file{view.stats.files === 1 ? '' : 's'}</>}
      </div>
      {view.htmlUrl && (
        <a href={view.htmlUrl} target="_blank" rel="noreferrer"
           className="text-accent text-[10.5px] hover:underline">Open ↗</a>
      )}
    </div>
  );
}
