import { useEffect, useRef, useState } from 'react';

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

  const statusColor = {
    running: 'text-muted',
    done: 'text-accent',
    error: 'text-danger',
  }[status];

  // Pop the check briefly when transitioning running → done.
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

  // Smooth expand/collapse via measured max-height.
  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsHeight, setDetailsHeight] = useState(0);
  useEffect(() => {
    if (!detailsRef.current) return;
    const el = detailsRef.current;
    const ro = new ResizeObserver(() => setDetailsHeight(el.scrollHeight));
    ro.observe(el);
    setDetailsHeight(el.scrollHeight);
    return () => ro.disconnect();
  }, [open]);

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface/40 transition-colors"
      >
        <span className="flex items-center gap-2">
          <StatusGlyph status={status} justFinished={justFinished} />
          <span className="font-medium">{name}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className={`uppercase tracking-wide text-[10px] ${statusColor}`}>{status}</span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
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
          className="px-3 pb-3 text-xs font-mono space-y-2"
        >
          <div>
            <div className="text-muted mb-1">input</div>
            <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(input, null, 2)}</pre>
          </div>
          {name === 'screenshot' && hasPath(result) && (
            <img
              src={`file://${(result as { path: string }).path}`}
              alt="screenshot"
              className="my-2 max-w-full rounded border border-border"
            />
          )}
          {result !== undefined && (
            <div>
              <div className="text-muted mb-1">result</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusGlyph({
  status,
  justFinished,
}: {
  status: 'running' | 'done' | 'error';
  justFinished: boolean;
}) {
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="w-3.5 h-3.5 text-muted otto-spin"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="w-3.5 h-3.5 text-danger"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className={`w-3.5 h-3.5 text-accent ${justFinished ? 'otto-pop' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function hasPath(result: unknown): result is { path: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'path' in result &&
    typeof (result as { path: unknown }).path === 'string'
  );
}
