import type { ResultView } from '../shared/tool-presenters';

export function ToolResultRenderer({ view }: { view: ResultView }) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'image':
      return (
        <div>
          <img src={view.src} alt="tool result" loading="lazy"
               className="block max-w-full rounded border border-border" />
          {view.meta && <div className="text-[10px] text-muted mt-1">{view.meta}</div>}
        </div>
      );
    case 'terminal': {
      const exit = view.exitCode;
      const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-emerald-500' : 'text-danger';
      return (
        <div className="rounded bg-bg/80 p-2 font-mono text-[10px] leading-relaxed">
          {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
          {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
          {exit !== undefined && (
            <div className={`text-[10px] mt-1 ${exitClass}`}>↳ exited {exit}</div>
          )}
        </div>
      );
    }
    case 'kv':
      return (
        <dl className="grid grid-cols-[max-content,1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
          {view.entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
      );
    case 'error':
      return (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2 py-1.5 text-[11px]">
          {view.text}
        </div>
      );
    case 'markdown':
      return <div className="text-[11px] whitespace-pre-wrap break-words">{view.text}</div>;
    case 'json':
      return (
        <pre className="bg-bg/60 rounded p-2 overflow-x-auto text-[10px] whitespace-pre-wrap break-words">
          {JSON.stringify(view.value, null, 2)}
        </pre>
      );
  }
}
