import { Fragment } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'kv' }>;

export function KvCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10.5px]' : 'text-[11.5px]';
  return (
    <dl className={`grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 font-mono ${fs} m-0`}>
      {view.entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted m-0">{k}</dt>
          <dd className="break-all m-0">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
