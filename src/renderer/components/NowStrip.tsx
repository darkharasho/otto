import { useEffect, useState } from 'react';
import { describeTool } from '@shared/tool-presenters';
import { useOttoStore } from '../state/store';
import type { ActiveSessionState } from '../state/store';

// One-line answer to "what is Otto doing right now?" — sits between the
// message list and the composer. Active: running tool calls + processes with
// ticking elapsed. Idle: quiet state with the session's time range.

interface RunningItem {
  id: string; // matches the activity-<id> DOM anchor from Message.tsx
  label: string;
}

// First time the strip saw an item running — elapsed is renderer-observed
// (tool-call events don't carry timestamps yet).
const firstSeen = new Map<string, number>();

function collectRunning(session: ActiveSessionState): RunningItem[] {
  const items: RunningItem[] = [];
  // In-flight tool calls live in the streaming assistant message.
  if (session.currentTurnActive) {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const m = session.messages[i]!;
      if (m.role !== 'assistant') continue;
      const resolved = new Set<string>();
      for (const b of m.content) if (b.type === 'tool_result') resolved.add(b.callId);
      for (const b of m.content) {
        if (b.type === 'tool_use' && !resolved.has(b.callId)) {
          items.push({ id: b.callId, label: describeTool(b.name).label.toLowerCase() });
        }
      }
      break;
    }
  }
  // Long-running spawned processes can outlive the turn.
  for (const m of session.messages) {
    for (const b of m.content) {
      if (b.type === 'process_output' && b.status === 'running') {
        items.push({ id: b.handle, label: b.command.split(/\s+/)[0] ?? 'process' });
      }
    }
  }
  return items;
}

function stepInfo(session: ActiveSessionState): { current: number; total: number } | null {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const m = session.messages[i]!;
    for (let j = m.content.length - 1; j >= 0; j -= 1) {
      const b = m.content[j]!;
      if (b.type !== 'tool_use' || !/TodoWrite|TaskCreate|TaskUpdate/.test(b.name)) continue;
      const todos = b.input && typeof b.input === 'object'
        ? (b.input as Record<string, unknown>)['todos']
        : undefined;
      if (!Array.isArray(todos) || todos.length === 0) continue;
      const statuses = todos.map((t) =>
        t && typeof t === 'object' ? String((t as Record<string, unknown>)['status'] ?? 'pending') : 'pending'
      );
      const active = statuses.indexOf('in_progress');
      const done = statuses.filter((s) => s === 'completed').length;
      return { current: Math.min(active >= 0 ? active + 1 : done + 1, statuses.length), total: statuses.length };
    }
  }
  return null;
}

function clockHM(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function elapsedLabel(fromMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  return s < 60 ? `0:${String(s).padStart(2, '0')}` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function NowStrip({ onStop }: { onStop: () => void }) {
  const session = useOttoStore((s) => s.activeSession);
  const [now, setNow] = useState(Date.now());

  const running = session ? collectRunning(session) : [];
  for (const item of running) {
    if (!firstSeen.has(item.id)) firstSeen.set(item.id, Date.now());
  }

  useEffect(() => {
    if (running.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  if (!session || session.messages.length === 0) return null;

  if (running.length === 0) {
    const first = session.messages[0]!.createdAt;
    const last = session.messages[session.messages.length - 1]!.createdAt;
    return (
      <div
        data-testid="now-strip"
        className="flex items-center gap-2 px-3 py-1.5 rounded-[9px] border border-border/70 bg-white/[0.02] text-[11px] text-muted"
      >
        <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[#3f4046] flex-shrink-0" />
        <span>All quiet — nothing running</span>
        {last > first && (
          <span className="ml-auto font-mono text-[10px] text-[#5f6167]">
            session {clockHM(first)} – {clockHM(last)}
          </span>
        )}
      </div>
    );
  }

  const step = stepInfo(session);
  return (
    <div
      data-testid="now-strip"
      className="flex items-center gap-2 px-3 py-1.5 rounded-[9px] border border-accent/30 bg-accent/[0.06] text-[11px] min-w-0"
    >
      <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-accent otto-pulse-dot flex-shrink-0" />
      <span className="font-medium text-text/90 flex-shrink-0">
        {running.length} running
      </span>
      <span className="text-muted flex-shrink-0">—</span>
      <span className="flex items-center gap-1 min-w-0 truncate">
        {running.slice(0, 3).map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => document.getElementById(`activity-${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="text-accent hover:underline truncate"
          >
            {i > 0 && <span className="text-muted no-underline">· </span>}
            {item.label}
            {firstSeen.has(item.id) && (
              <span className="font-mono text-[10px] text-accent/70"> ({elapsedLabel(firstSeen.get(item.id)!, now)})</span>
            )}
          </button>
        ))}
        {running.length > 3 && <span className="text-muted flex-shrink-0">+{running.length - 3} more</span>}
      </span>
      <span className="ml-auto flex items-center gap-2 flex-shrink-0">
        {step && <span className="text-muted">step {step.current} of {step.total}</span>}
        <button
          type="button"
          onClick={onStop}
          className="px-2 py-0.5 rounded-md border border-border text-muted hover:text-danger hover:border-danger/50 text-[10.5px]"
        >
          Pause all
        </button>
      </span>
    </div>
  );
}
