import { useState } from 'react';

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

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface/40"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">⚙</span>
          <span className="font-medium">{name}</span>
        </span>
        <span className={`uppercase tracking-wide text-[10px] ${statusColor}`}>{status}</span>
      </button>
      {open && (
        <div data-testid="toolcall-details" className="px-3 pb-3 text-xs font-mono space-y-2">
          <div>
            <div className="text-muted mb-1">input</div>
            <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(input, null, 2)}</pre>
          </div>
          {result !== undefined && (
            <div>
              <div className="text-muted mb-1">result</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
