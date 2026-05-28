import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'typed' }>;

export function TypedCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="inline-flex items-baseline gap-2 max-w-full">
      <span className="px-2 py-1 rounded bg-surface/60 font-mono text-[11px] break-words">
        "{view.text}"
      </span>
      <span className="text-muted text-[10px]">{view.text.length} char{view.text.length === 1 ? '' : 's'}</span>
    </div>
  );
}
