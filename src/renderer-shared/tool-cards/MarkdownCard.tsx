import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'markdown' }>;

export function MarkdownCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="prose-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.text}</ReactMarkdown>
    </div>
  );
}
