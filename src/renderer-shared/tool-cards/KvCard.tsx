import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'kv' }>;

export function KvCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10.5px]' : 'text-[11.5px]';
  return (
    <dl className={`grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 font-mono ${fs}`}>
      {view.entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
