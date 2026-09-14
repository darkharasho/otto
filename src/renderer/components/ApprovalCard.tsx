import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ContentBlock } from '@shared/messages';
import { describeTool } from '@shared/tool-presenters';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'pending_tool_use' }>;
}

const CONFIRM_WORD = 'confirm';

// Action class drives the chrome: reversible is a one-click violet approve,
// destructive is amber and gated behind reviewing the exact input,
// irreversible is red and armed by typing a confirmation word.
const CHROME: Record<string, { container: string; badge: string }> = {
  read: {
    container: 'border-accent/40 from-accent/[0.08] to-accent/[0.02] shadow-[0_0_24px_-8px_rgba(124,125,255,0.4)]',
    badge: 'bg-white/[0.05] text-muted border border-border',
  },
  reversible: {
    container: 'border-accent/40 from-accent/[0.08] to-accent/[0.02] shadow-[0_0_24px_-8px_rgba(124,125,255,0.4)]',
    badge: 'bg-good/10 text-good border border-good/40',
  },
  destructive: {
    container: 'border-warn/50 from-warn/[0.07] to-warn/[0.02] shadow-[0_0_24px_-8px_rgba(245,160,75,0.35)]',
    badge: 'bg-warn/15 text-warn border border-warn/40',
  },
  irreversible: {
    container: 'border-danger/50 from-danger/[0.07] to-danger/[0.02] shadow-[0_0_24px_-8px_rgba(239,68,68,0.35)]',
    badge: 'bg-danger/20 text-danger border border-danger/50',
  },
};

export function ApprovalCard({ block }: Props) {
  const decided = block.decision !== 'pending';
  const [reviewed, setReviewed] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [showDecided, setShowDecided] = useState(false);

  // "approved by you · 0.8s" — only measurable for cards we watched decide.
  const mountedAt = useRef(Date.now());
  const wasPending = useRef(!decided);
  const [decidedInMs, setDecidedInMs] = useState<number | null>(null);
  useEffect(() => {
    if (decided && wasPending.current && decidedInMs === null) {
      setDecidedInMs(Date.now() - mountedAt.current);
    }
  }, [decided, decidedInMs]);

  const submit = useCallback(
    async (decision: 'approve' | 'approve-session' | 'deny') => {
      await ipc.invoke('autonomy.decide', { decisionId: block.decisionId, decision });
    },
    [block.decisionId]
  );

  const desc = describeTool(block.name);
  const command =
    block.input && typeof block.input === 'object'
      ? (block.input as Record<string, unknown>)['command']
      : undefined;
  const inputText = typeof command === 'string'
    ? command
    : (() => { try { return JSON.stringify(block.input, null, 2); } catch { return String(block.input); } })();

  const cls = block.actionClass;
  const chrome = CHROME[cls] ?? CHROME['read']!;
  const armed =
    cls === 'destructive' ? reviewed
    : cls === 'irreversible' ? confirmText.trim().toLowerCase() === CONFIRM_WORD
    : true;

  // ⌘⏎ / Ctrl+⏎ approves one-click classes while pending.
  useEffect(() => {
    if (decided || (cls !== 'read' && cls !== 'reversible')) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submit('approve');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decided, cls, submit]);

  // Settled receipt once decided: attribution line, click to review the details.
  if (decided && !showDecided) {
    const approved = block.decision !== 'denied';
    return (
      <button
        type="button"
        onClick={() => setShowDecided(true)}
        className="otto-receipt my-1 w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:border-accent/40 transition-colors"
      >
        <span className="w-4 h-4 rounded bg-accent/10 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
          <ShieldCheck className="w-2.5 h-2.5" />
        </span>
        <span className="flex items-baseline gap-1.5 min-w-0 flex-1">
          <span className="text-[11px] font-medium truncate">{desc.label}</span>
          <span className="font-mono text-[11px] text-muted truncate">{inputText.split('\n')[0]}</span>
        </span>
        <span className={`text-[10.5px] flex-shrink-0 ${approved ? 'text-accent' : 'text-danger'}`}>
          {approved
            ? `✓ approved by you${block.decision === 'approved-session' ? ' (session)' : ''}${
                decidedInMs !== null ? ` · ${(decidedInMs / 1000).toFixed(1)}s` : ''
              }`
            : '✗ denied by you'}
        </span>
      </button>
    );
  }

  return (
    <div className={`my-2 rounded-[11px] border bg-gradient-to-b p-3 text-sm ${chrome.container}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-3.5 h-3.5" />
          </span>
          <span className="text-[12.5px] font-semibold truncate">
            Wants to {desc.label.toLowerCase() === block.name.toLowerCase() ? `run ${block.name}` : desc.label.toLowerCase()}
          </span>
          <span className={`inline-block text-[9.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md flex-shrink-0 ${chrome.badge}`}>
            {cls}
          </span>
        </div>
        {decided && (
          <span className="text-[11px] uppercase text-accent flex-shrink-0">
            {block.decision === 'denied' ? 'Denied' : 'Approved'}
          </span>
        )}
      </div>

      <div className="relative mb-2">
        <pre
          className={`text-xs font-mono bg-term border border-border/70 rounded-[7px] p-2 overflow-x-auto m-0 ${
            cls === 'destructive' && !reviewed ? 'max-h-[72px] overflow-hidden' : ''
          }`}
        >
          {typeof command === 'string' ? <><span className="text-accent select-none">$ </span>{command}</> : inputText}
        </pre>
        {cls === 'destructive' && !reviewed && (
          <div className="absolute inset-x-0 bottom-0 h-8 rounded-b-[7px] bg-gradient-to-t from-bg to-transparent pointer-events-none" />
        )}
      </div>

      {block.reason && (
        <div className="text-[10.5px] text-muted mb-2">{block.reason}</div>
      )}

      {cls === 'irreversible' && !decided && (
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={`Type "${CONFIRM_WORD}" to arm approval`}
          aria-label="Confirmation word"
          className="w-full mb-2 px-2.5 py-1.5 text-xs font-mono rounded-md bg-bg/60 border border-danger/40 placeholder:text-muted/60 focus:outline-none focus:border-danger"
        />
      )}

      <div className="flex items-center gap-2">
        {cls === 'destructive' && !reviewed && !decided ? (
          <button
            type="button"
            onClick={() => setReviewed(true)}
            className="px-3 py-1 text-xs rounded-md border border-warn/60 text-warn hover:bg-warn/10"
          >
            Review the full command
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => submit('approve')}
          disabled={decided || !armed}
          className={[
            'px-3 py-1 text-xs rounded-md disabled:opacity-40',
            cls === 'destructive'
              ? 'bg-warn text-bg font-medium hover:brightness-110'
              : cls === 'irreversible'
                ? 'bg-danger text-white font-medium hover:brightness-110'
                : 'otto-send hover:brightness-110',
          ].join(' ')}
        >
          Approve & run
          {(cls === 'read' || cls === 'reversible') && !decided && (
            <kbd className="ml-1.5 text-[9px] opacity-70 font-mono">⌘⏎</kbd>
          )}
        </button>
        {!block.catastrophic && cls !== 'irreversible' && (
          <button
            type="button"
            onClick={() => submit('approve-session')}
            disabled={decided || !armed}
            className="px-3 py-1 text-xs rounded-md border border-accent/60 text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            Approve for session
          </button>
        )}
        <button
          type="button"
          onClick={() => submit('deny')}
          disabled={decided}
          className="px-3 py-1 text-xs rounded-md border border-border text-muted hover:text-danger hover:border-danger/50 disabled:opacity-40"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
