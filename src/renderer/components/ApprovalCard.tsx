import { useCallback } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'pending_tool_use' }>;
}

export function ApprovalCard({ block }: Props) {
  const submit = useCallback(
    async (decision: 'approve' | 'approve-session' | 'deny') => {
      await ipc.invoke('autonomy.decide', { decisionId: block.decisionId, decision });
    },
    [block.decisionId]
  );

  const inputSummary = (() => {
    try {
      return JSON.stringify(block.input);
    } catch {
      return String(block.input);
    }
  })();

  const decided = block.decision !== 'pending';

  return (
    <div className="my-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-medium">
          <span>{block.name}</span>
          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">
            {block.actionClass}
          </span>
        </div>
        {decided && (
          <span className="text-[11px] uppercase text-accent">
            {block.decision === 'denied' ? 'Denied' : 'Approved'}
          </span>
        )}
      </div>
      <pre className="text-xs font-mono bg-bg/60 rounded p-2 overflow-x-auto mb-2">{inputSummary}</pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => submit('approve')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded bg-accent text-bg disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => submit('approve-session')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded border border-accent text-accent disabled:opacity-50"
        >
          Approve for session
        </button>
        <button
          type="button"
          onClick={() => submit('deny')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded border border-danger text-danger disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
