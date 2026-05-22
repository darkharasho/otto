import { useCallback } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'process_output' }>;
}

const STATUS_LABEL: Record<'running' | 'exited' | 'killed', string> = {
  running: 'running',
  exited: 'exited',
  killed: 'killed',
};

const STATUS_COLOR: Record<'running' | 'exited' | 'killed', string> = {
  running: 'text-amber-400',
  exited: 'text-accent',
  killed: 'text-danger',
};

const MAX_VISIBLE_LINES = 1000;

export function ProcessCard({ block }: Props) {
  const cancel = useCallback(async () => {
    await ipc.invoke('shell.kill', { handle: block.handle });
  }, [block.handle]);

  const lines = block.lines.length > MAX_VISIBLE_LINES
    ? [
        { stream: 'stderr' as const, data: `[${block.lines.length - MAX_VISIBLE_LINES} earlier lines truncated]` },
        ...block.lines.slice(-MAX_VISIBLE_LINES),
      ]
    : block.lines;

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40 text-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-muted">$</span>
          <span className="font-mono">{block.command}</span>
        </div>
        <div className="flex items-center gap-2">
          {block.status === 'exited' && block.exitCode !== null && (
            <span className="text-[10px] uppercase tracking-wide text-accent">exit {block.exitCode}</span>
          )}
          <span className={`text-[10px] uppercase tracking-wide ${STATUS_COLOR[block.status]}`}>
            {STATUS_LABEL[block.status]}
          </span>
          {block.status === 'running' && (
            <button
              type="button"
              onClick={cancel}
              className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-danger text-danger"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <pre className="text-xs font-mono px-3 py-2 max-h-64 overflow-y-auto whitespace-pre-wrap">
        {lines.map((l, i) => (
          <div key={i} className={l.stream === 'stderr' ? 'text-danger' : ''}>{l.data}</div>
        ))}
      </pre>
    </div>
  );
}
