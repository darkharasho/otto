import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ToolIcon } from './ToolIcon';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'process_output' }>;
}

const MAX_VISIBLE_LINES = 1000;

type ProcessStatus = 'running' | 'exited' | 'killed';
type GlyphStatus = 'running' | 'done' | 'error';

function mapGlyphStatus(status: ProcessStatus, exitCode: number | null): GlyphStatus {
  if (status === 'running') return 'running';
  if (status === 'killed') return 'error';
  // exited
  return exitCode === 0 ? 'done' : 'error';
}

function StatusGlyph({ status }: { status: GlyphStatus }) {
  if (status === 'running') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-muted otto-spin"
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-danger"
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-accent"
         fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function ProcessCard({ block }: Props) {
  const [open, setOpen] = useState(true);
  const cancel = useCallback(async () => {
    await ipc.invoke('shell.kill', { handle: block.handle });
  }, [block.handle]);

  const lines = useMemo(
    () =>
      block.lines.length > MAX_VISIBLE_LINES
        ? [
            { stream: 'stderr' as const, data: `[${block.lines.length - MAX_VISIBLE_LINES} earlier lines truncated]` },
            ...block.lines.slice(-MAX_VISIBLE_LINES),
          ]
        : block.lines,
    [block.lines],
  );

  const glyphStatus = mapGlyphStatus(block.status, block.exitCode);

  const statusColor = {
    running: 'text-muted',
    done: 'text-accent',
    error: 'text-danger',
  }[glyphStatus];

  const statusLabel = {
    running: 'RUNNING',
    exited: block.exitCode !== null && block.exitCode !== 0 ? `EXITED ${block.exitCode}` : 'EXITED',
    killed: 'KILLED',
  }[block.status];

  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useEffect(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    const ro = new ResizeObserver(() => setBodyHeight(el.scrollHeight));
    ro.observe(el);
    setBodyHeight(el.scrollHeight);
    return () => ro.disconnect();
  }, [open, lines]);

  // Auto-scroll terminal to bottom while streaming
  const terminalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (block.status === 'running' && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [block.lines, block.status]);

  // Group consecutive same-stream lines into blocks
  type LineGroup = { stream: 'stdout' | 'stderr'; text: string };
  const groups: LineGroup[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last.stream === line.stream) {
      last.text += '\n' + line.data;
    } else {
      groups.push({ stream: line.stream, text: line.data });
    }
  }

  const footerStatus =
    block.status === 'exited'
      ? `↳ exited ${block.exitCode ?? ''}`
      : block.status === 'killed'
      ? '↳ killed'
      : '↳ running…';

  const footerColor =
    block.status === 'exited'
      ? block.exitCode === 0
        ? 'text-accent'
        : 'text-danger'
      : block.status === 'killed'
      ? 'text-danger'
      : 'text-muted';

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40 overflow-hidden">
      {/* Header row — click on the row to toggle; cancel is an independent <button> */}
      <div
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface/40 transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="w-6 h-6 rounded-md bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
            <ToolIcon name="terminal" className="w-3.5 h-3.5" />
          </span>
          <span className="flex flex-col min-w-0 text-left">
            <span className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted font-semibold">Shell</span>
              <span className="font-medium truncate">Spawn process</span>
            </span>
            <span className="font-mono text-[11px] text-muted truncate">{block.command}</span>
          </span>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          {block.status === 'running' && (
            <button
              type="button"
              aria-label="Cancel"
              onClick={(e) => { e.stopPropagation(); void cancel(); }}
              className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-danger text-danger hover:bg-danger/10 transition-colors"
            >
              Cancel
            </button>
          )}
          <StatusGlyph status={glyphStatus} />
          <span className={`uppercase tracking-wide text-[10px] ${statusColor}`}>{statusLabel}</span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>
      <div
        style={{ maxHeight: open ? bodyHeight : 0 }}
        className="transition-[max-height] duration-200 ease-out overflow-hidden"
      >
        <div ref={bodyRef} className="px-3 pb-3 border-t border-border/40 pt-3">
          <div
            ref={terminalRef}
            className="rounded bg-bg/80 font-mono leading-relaxed max-h-[320px] overflow-auto text-[11px] p-2.5"
          >
            {groups.map((g, i) => (
              <pre
                key={i}
                className={`whitespace-pre-wrap break-words m-0 ${g.stream === 'stderr' ? 'text-danger' : ''}`}
              >
                {g.text}
              </pre>
            ))}
            {block.status === 'running' && (
              <span className="inline-block w-2 h-3 align-baseline bg-accent/70 otto-blink" />
            )}
            <div className={`text-[10px] mt-1.5 ${footerColor}`}>{footerStatus}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
