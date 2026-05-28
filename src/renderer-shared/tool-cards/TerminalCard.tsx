import { useEffect, useRef } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

export function TerminalCard({ view, compact }: { view: View; compact?: boolean }) {
  const exit = view.exitCode;
  const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
  const size = compact ? 'text-[10px] p-2' : 'text-[11px] p-2.5';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [view.stdout, view.stderr, view.streaming]);
  return (
    <div ref={ref} className={`rounded bg-bg/80 font-mono leading-relaxed max-h-[320px] overflow-auto ${size}`}>
      {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
      {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
      {view.streaming && <span className="inline-block w-2 h-3 align-baseline bg-accent/70 otto-blink" />}
      {exit !== undefined && (
        <div className={`text-[10px] mt-1.5 ${exitClass}`}>
          ↳ exited {exit}{view.durationMs ? ` · ${view.durationMs}ms` : ''}
        </div>
      )}
      {view.streaming && exit === undefined && (
        <div className="text-[10px] mt-1.5 text-muted">↳ running…</div>
      )}
    </div>
  );
}
