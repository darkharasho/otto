import { useEffect, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'tasks' }>;

// First time the renderer sees a task title enter a state. Module-scoped so
// the times survive across the successive plan-update cards in a session.
const taskTimes = new Map<string, { startedAt?: number; completedAt?: number }>();

function noteTimes(items: View['items']) {
  const now = Date.now();
  for (const it of items) {
    const t = taskTimes.get(it.title) ?? {};
    if (it.status === 'in_progress' && t.startedAt === undefined) t.startedAt = now;
    if (it.status === 'completed' && t.completedAt === undefined) t.completedAt = now;
    taskTimes.set(it.title, t);
  }
}

function clock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function elapsed(fromMs: number): string {
  const s = Math.floor((Date.now() - fromMs) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function glyph(s: 'pending' | 'in_progress' | 'completed'): JSX.Element {
  if (s === 'completed') return <span className="text-accent">✓</span>;
  if (s === 'in_progress') {
    return (
      <span className="relative inline-flex w-2.5 h-2.5 rounded-full border border-accent/60 flex-shrink-0 translate-y-px">
        <span className="absolute inset-[2px] rounded-full bg-accent otto-pulse-dot" />
      </span>
    );
  }
  return <span className="text-muted">○</span>;
}

export function TasksCard({ view }: { view: View; compact?: boolean }) {
  noteTimes(view.items);
  const done = view.items.filter((i) => i.status === 'completed').length;
  const anyRunning = view.items.some(
    (i) => i.status === 'in_progress' && taskTimes.get(i.title)?.startedAt !== undefined
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  return (
    <div className="space-y-0.5">
      <div className="text-muted text-[10.5px] mb-1">{done}/{view.items.length} complete</div>
      {view.items.map((it, i) => {
        const t = taskTimes.get(it.title);
        return (
          <div key={i} className="flex items-baseline gap-2 text-[11.5px]">
            {glyph(it.status)}
            <span className={`min-w-0 flex-1 ${it.status === 'completed' ? 'text-muted line-through' : ''}`}>
              {it.title}
            </span>
            {it.status === 'completed' && t?.completedAt !== undefined && (
              <span className="font-mono text-[10.5px] text-[#5f6167] flex-shrink-0">{clock(t.completedAt)}</span>
            )}
            {it.status === 'in_progress' && t?.startedAt !== undefined && (
              <span className="font-mono text-[10.5px] text-accent/80 flex-shrink-0">running · {elapsed(t.startedAt)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
