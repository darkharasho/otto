import { useEffect, useState } from 'react';
import { Award, Copy, Lightbulb, Undo2 } from 'lucide-react';
import type { ContentBlock } from '@shared/messages';

type OutcomeBlock = Extract<ContentBlock, { type: 'outcome' }>;

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}

/**
 * End-of-task summary (spec §8): medal chip, one-line title, stats, fact
 * tiles, undo row, learned note. Data comes whole from main — nothing here is
 * synthesized. Violet-ring emphasis matches the pending-approval treatment:
 * the two "look at me" moments.
 */
export function OutcomeCard({ block }: { block: OutcomeBlock }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const stats = [
    formatDuration(block.durationMs),
    `${block.toolCalls} tool call${block.toolCalls === 1 ? '' : 's'}`,
    ...(block.approvals !== undefined && block.approvals > 0
      ? [`${block.approvals} approval${block.approvals === 1 ? '' : 's'}`]
      : []),
  ].join(' · ');

  const facts: Array<{ heading: string; text: string; mono?: boolean }> = [
    ...(block.cause !== undefined ? [{ heading: 'Cause', text: block.cause }] : []),
    ...(block.fix !== undefined ? [{ heading: 'Fix', text: block.fix, mono: true }] : []),
    ...(block.verified !== undefined ? [{ heading: 'Verified', text: block.verified }] : []),
  ];

  const copyUndo = async () => {
    if (!block.undoCommand) return;
    try {
      await navigator.clipboard.writeText(block.undoCommand);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the command is still visible to copy by hand.
    }
  };

  return (
    <div
      data-testid="outcome-card"
      className="my-3 rounded-[10px] otto-elevated ring-1 ring-accent/40 shadow-[0_0_18px_rgba(124,125,255,0.18)] overflow-hidden"
    >
      <div className="flex items-start gap-2.5 px-3 pt-3">
        <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
          <Award className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold leading-snug">{block.title}</div>
          <div className="text-[10.5px] text-muted mt-0.5">{stats}</div>
        </div>
      </div>

      {facts.length > 0 && (
        <div className={`px-3 pt-2.5 grid gap-1.5 ${facts.length >= 3 ? 'grid-cols-3' : facts.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {facts.map((f) => (
            <div key={f.heading} className="rounded-[7px] border border-border bg-bg/40 px-2 py-1.5 min-w-0">
              <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted">{f.heading}</div>
              <div className={`text-[11px] mt-0.5 break-words ${f.mono ? 'font-mono' : ''}`}>{f.text}</div>
            </div>
          ))}
        </div>
      )}

      {block.undoCommand && (
        <div className="mx-3 mt-2.5 flex items-center gap-2 rounded-[7px] border border-border bg-term px-2.5 py-1.5">
          <Undo2 className="w-3 h-3 text-muted flex-shrink-0" aria-hidden />
          <span className="text-[10.5px] text-muted flex-shrink-0">Undo anytime:</span>
          <code className="font-mono text-[11px] truncate flex-1">{block.undoCommand}</code>
          <button
            type="button"
            onClick={copyUndo}
            className="flex items-center gap-1 text-[10.5px] text-muted hover:text-text transition-colors flex-shrink-0"
          >
            <Copy className="w-3 h-3" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {block.learnedNote && (
        <div className="mx-3 mt-2 flex items-baseline gap-2 text-[10.5px] text-muted">
          <Lightbulb className="w-3 h-3 text-accent flex-shrink-0 self-center" aria-hidden />
          <span>
            Saved to machine notes: <span className="text-text">{block.learnedNote}</span>
          </span>
        </div>
      )}

      <div className="pb-3" />
    </div>
  );
}
