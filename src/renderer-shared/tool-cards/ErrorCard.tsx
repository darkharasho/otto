import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'error' }>;

export function ErrorCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2.5 py-2 text-xs">
      <div>{view.text}</div>
      {view.suggestion && <div className="mt-1.5 text-accent">💡 {view.suggestion}</div>}
    </div>
  );
}
