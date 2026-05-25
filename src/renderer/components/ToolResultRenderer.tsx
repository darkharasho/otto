import type { ResultView } from '@shared/tool-presenters';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props { view: ResultView }

export function ToolResultRenderer({ view }: Props) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'image':
      return (
        <div>
          <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
               className="max-w-full rounded border border-border" />
          {view.meta && <div className="text-[10.5px] text-muted mt-1">{view.meta}</div>}
        </div>
      );
    case 'terminal': {
      const exit = view.exitCode;
      const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
      return (
        <div className="rounded bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed">
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
    case 'markdown':
      return (
        <div className="prose-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.text}</ReactMarkdown>
        </div>
      );
    case 'kv':
      return (
        <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 font-mono text-[11.5px]">
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
        <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2.5 py-2 text-xs">
          {view.text}
        </div>
      );
    case 'json':
      return (
        <pre className="bg-bg/60 rounded p-2 overflow-x-auto text-[11px]">
          {JSON.stringify(view.value, null, 2)}
        </pre>
      );
  }
}
