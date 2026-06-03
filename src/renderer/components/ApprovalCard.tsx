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

  const tagClass: Record<string, string> = {
    read: 'bg-white/[0.05] text-muted border border-border',
    reversible: 'bg-amber-500/15 text-amber-300 border border-amber-500/40',
    destructive: 'bg-danger/15 text-danger border border-danger/40',
    irreversible: 'bg-danger/20 text-danger border border-danger/50',
  };
  const tag = tagClass[block.actionClass] ?? tagClass.read;

  return (
    <div className="my-2 rounded-[11px] border border-accent/40 bg-gradient-to-b from-accent/[0.08] to-accent/[0.02] p-3 text-sm shadow-[0_0_24px_-8px_rgba(124,125,255,0.4)]">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-medium">
          <span>{block.name}</span>
          <span className={`ml-2 inline-block text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md ${tag}`}>
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
          className="otto-send px-3 py-1 text-xs rounded-md hover:brightness-110 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => submit('approve-session')}
          disabled={decided}
          className="px-3 py-1 text-xs rounded-md border border-accent/60 text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          Approve for session
        </button>
        <button
          type="button"
          onClick={() => submit('deny')}
          disabled={decided}
          className="px-3 py-1 text-xs rounded-md border border-border text-muted hover:text-danger hover:border-danger/50 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
