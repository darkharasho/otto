import type { ResultView } from '@shared/tool-presenters';
import { describeTool } from '@shared/tool-presenters';
import type { DelegationSnapshot } from '@shared/delegation';
import { MarkdownCard } from './MarkdownCard';

type View = Extract<ResultView, { kind: 'delegation' }>;

const STATUS_LABEL: Record<DelegationSnapshot['status'], string> = {
  connecting: 'Connecting',
  busy: 'Busy',
  running: 'Working',
  done: 'Done',
  interrupted: 'Interrupted',
  error: 'Error',
  lost: 'Connection lost',
};

const DOT: Record<string, string> = {
  running: 'bg-accent animate-pulse',
  done: 'bg-good',
  error: 'bg-danger',
  denied: 'bg-warn',
};

/**
 * The other machine's transcript, as seen from this one. Shared by the phone
 * UIs — approvals raised on the remote are shown as a waiting note, because
 * only the delegating desktop can answer them (`peers:decide` is IPC-only).
 */
export function DelegationCard({ view }: { view: View; compact?: boolean }) {
  const s = view.snapshot;
  return (
    <div className="space-y-1.5" data-testid="delegation-card">
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="font-medium text-text">{s.machine}</span>
        <span>{STATUS_LABEL[s.status] ?? s.status}</span>
      </div>

      {s.items.map((it, i) =>
        it.kind === 'text' ? (
          <MarkdownCard key={i} view={{ kind: 'markdown', text: it.text }} />
        ) : (
          <div key={it.callId || i} className="flex items-center gap-2 text-[11px]" title={it.result}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DOT[it.status] ?? 'bg-muted'}`} />
            <span className="font-medium flex-shrink-0">{describeTool(it.name).label}</span>
            <span className="font-mono text-muted truncate">{it.summary}</span>
          </div>
        )
      )}

      {s.pendingApproval && (
        <div className="text-[10.5px] text-warn">
          Waiting for approval of {describeTool(s.pendingApproval.name).label} on {s.machine}.
        </div>
      )}
      {s.pendingSudo && (
        <div className="text-[10.5px] text-warn">Waiting for a password on {s.machine}.</div>
      )}
      {s.error && <div className="text-[11px] text-danger">{s.error}</div>}
    </div>
  );
}
