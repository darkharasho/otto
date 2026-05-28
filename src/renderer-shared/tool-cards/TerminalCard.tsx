import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

export function TerminalCard({ view, compact }: { view: View; compact?: boolean }) {
  const exit = view.exitCode;
  const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
  const size = compact ? 'text-[10px] p-2' : 'text-[11px] p-2.5';
  return (
    <div className={`rounded bg-bg/80 font-mono leading-relaxed ${size}`}>
      {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
      {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
      {exit !== undefined && (
        <div className={`text-[10px] mt-1.5 ${exitClass}`}>
          ↳ exited {exit}{view.durationMs ? ` · ${view.durationMs}ms` : ''}
        </div>
      )}
    </div>
  );
}
