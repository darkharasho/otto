import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'json' }>;

export function JsonScalarCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <pre className={`bg-bg/60 rounded p-2 overflow-x-auto ${fs} whitespace-pre-wrap break-words`}>
      {typeof view.value === 'string' ? view.value : JSON.stringify(view.value, null, 2)}
    </pre>
  );
}
