import { useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'tree' }>;

function summary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length}}`;
  if (typeof v === 'string') return `"${v.length > 32 ? v.slice(0, 32) + '…' : v}"`;
  return String(v);
}

function valueColor(v: unknown): string {
  if (typeof v === 'string') return 'text-emerald-300';
  if (typeof v === 'number') return 'text-amber-300';
  if (typeof v === 'boolean') return 'text-purple-300';
  if (v === null) return 'text-muted';
  return '';
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const isCollection = !!value && typeof value === 'object';
  if (!isCollection) {
    return (
      <div className="flex gap-1.5" style={{ paddingLeft: depth * 12 }}>
        {name !== undefined && <span className="text-sky-300">{'"'}{name}{'"'}</span>}
        {name !== undefined && <span className="text-muted">:</span>}
        <span className={valueColor(value)}>{typeof value === 'string' ? <>{'"'}{value}{'"'}</> : String(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-left">
        <span className="text-muted mr-1">{open ? '▾' : '▸'}</span>
        {name !== undefined && <span className="text-sky-300">{'"'}{name}{'"'}</span>}
        {name !== undefined && <span className="text-muted mx-1">:</span>}
        <span className="text-muted">{summary(value)}</span>
      </button>
      {open && entries.map(([k, v]) => (
        <Node key={k} name={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

export function JsonTreeCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10.5px]' : 'text-[11.5px]';
  return (
    <div className={`font-mono ${fs} bg-bg/60 rounded p-2 overflow-x-auto`}>
      <Node value={view.value} depth={0} />
    </div>
  );
}
