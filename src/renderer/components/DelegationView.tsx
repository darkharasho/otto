import type { DelegationSnapshot } from '@shared/delegation';
import { describeTool } from '@shared/tool-presenters';
import { MarkdownCard } from '@renderer-shared/tool-cards/MarkdownCard';
import { ApprovalCard } from './ApprovalCard';
import { SudoPromptCard } from './SudoPromptCard';
import { ipc } from '../ipc';

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

export function DelegationView({ snapshot }: { snapshot: DelegationSnapshot }) {
  const { machine, pendingApproval: pa, pendingSudo: ps } = snapshot;
  return (
    <div className="space-y-1.5" data-testid="delegation-view">
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="font-medium text-text">{machine}</span>
        <span>{STATUS_LABEL[snapshot.status]}</span>
      </div>

      {snapshot.items.map((it, i) =>
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

      {pa && (
        <>
          <ApprovalCard
            block={{
              type: 'pending_tool_use',
              callId: pa.decisionId,
              decisionId: pa.decisionId,
              name: pa.name,
              input: pa.input,
              actionClass: pa.actionClass,
              reason: pa.reason,
              catastrophic: pa.catastrophic,
              decision: 'pending',
            }}
            denyOnly={pa.catastrophic}
            onDecide={(decision) => ipc.invoke('peers:decide', { machine, decisionId: pa.decisionId, decision })}
          />
          {pa.catastrophic && <div className="text-[10.5px] text-muted">Approve this one at {machine}.</div>}
        </>
      )}

      {ps && (
        <SudoPromptCard
          block={{ type: 'sudo_prompt', callId: ps.promptId, promptId: ps.promptId, command: ps.command, ...(ps.error ? { error: ps.error } : {}), status: 'pending' }}
          onSubmit={(password) => ipc.invoke('peers:sudo', { machine, promptId: ps.promptId, password })}
        />
      )}

      {snapshot.error && <div className="text-[11px] text-danger">{snapshot.error}</div>}
    </div>
  );
}
