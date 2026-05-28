import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'tasks' }>;

function glyph(s: 'pending' | 'in_progress' | 'completed'): JSX.Element {
  if (s === 'completed') return <span className="text-accent">✓</span>;
  if (s === 'in_progress') return <span className="text-amber-400 otto-pulse">●</span>;
  return <span className="text-muted">○</span>;
}

export function TasksCard({ view }: { view: View; compact?: boolean }) {
  const done = view.items.filter(i => i.status === 'completed').length;
  return (
    <div className="space-y-0.5">
      <div className="text-muted text-[10.5px] mb-1">{done}/{view.items.length} complete</div>
      {view.items.map((it, i) => (
        <div key={i} className="flex items-baseline gap-2 text-[11.5px]">
          {glyph(it.status)}
          <span className={it.status === 'completed' ? 'text-muted line-through' : ''}>{it.title}</span>
        </div>
      ))}
    </div>
  );
}
