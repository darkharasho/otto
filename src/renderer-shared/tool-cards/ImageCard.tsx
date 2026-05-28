import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  return (
    <div>
      <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
           className="max-w-full rounded border border-border" />
      {view.meta && (
        <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>{view.meta}</div>
      )}
    </div>
  );
}
