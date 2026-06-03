import { useEffect, useRef, useState } from 'react';
import { describeTool, summarizeInput, classifyResult } from '@shared/tool-presenters';
import { ToolIcon } from './ToolIcon';
import { ToolResultRenderer } from './ToolResultRenderer';

interface Props {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export function ToolCallCard({ name, input, result, isError }: Props) {
  const [open, setOpen] = useState(false);
  const status: 'running' | 'done' | 'error' =
    result === undefined ? 'running' : isError ? 'error' : 'done';

  const desc = describeTool(name);
  const summary = summarizeInput(name, input);
  const view = result === undefined ? null : classifyResult(name, result, isError, input);

  const inputIsEmpty =
    input === undefined ||
    input === null ||
    (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as object).length === 0);

  const wasRunning = useRef(status === 'running');
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (wasRunning.current && status === 'done') {
      setJustFinished(true);
      const t = setTimeout(() => setJustFinished(false), 700);
      return () => clearTimeout(t);
    }
    wasRunning.current = status === 'running';
  }, [status]);

  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsHeight, setDetailsHeight] = useState(0);
  useEffect(() => {
    if (!detailsRef.current) return;
    const el = detailsRef.current;
    const ro = new ResizeObserver(() => setDetailsHeight(el.scrollHeight));
    ro.observe(el);
    setDetailsHeight(el.scrollHeight);
    return () => ro.disconnect();
  }, [open, view]);

  return (
    <div className="my-2 rounded-[10px] otto-elevated overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface/40 transition-colors"
      >
        <span className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
            <ToolIcon name={desc.icon} className="w-3.5 h-3.5" />
          </span>
          <span className="flex flex-col min-w-0 text-left">
            <span className="flex items-baseline gap-1.5">
              {desc.group && (
                <span className="text-[10px] uppercase tracking-wide text-muted font-semibold">{desc.group}</span>
              )}
              <span className="font-medium truncate">{desc.label}</span>
            </span>
            {summary && (
              <span className="font-mono text-[11px] text-muted truncate">{summary}</span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          <span className={[
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide',
            status === 'error'
              ? 'bg-danger/15 text-danger border border-danger/30'
              : status === 'running'
                ? 'bg-white/[0.04] text-muted border border-border'
                : 'otto-accent-pill',
          ].join(' ')}>
            <StatusGlyph status={status} justFinished={justFinished} />
            {status}
          </span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      <div
        style={{ maxHeight: open ? detailsHeight : 0 }}
        className="transition-[max-height] duration-200 ease-out overflow-hidden"
      >
        <div
          ref={detailsRef}
          data-testid="toolcall-details"
          className="px-3 pb-3 text-xs space-y-3 border-t border-border/40 pt-3"
        >
          {!inputIsEmpty && view?.kind !== 'terminal' && (
            <div>
              <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Input</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto font-mono text-[11px]">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {view && view.kind !== 'empty' && (
            <div>
              {view.kind !== 'terminal' && !inputIsEmpty && (
                <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Result</div>
              )}
              <ToolResultRenderer view={view} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusGlyph({ status, justFinished }: { status: 'running' | 'done' | 'error'; justFinished: boolean }) {
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
    <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 text-accent ${justFinished ? 'otto-pop' : ''}`}
         fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
