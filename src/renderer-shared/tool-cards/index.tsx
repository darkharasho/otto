import type { ResultView } from '@shared/tool-presenters';
import { ImageCard } from './ImageCard';
import { TerminalCard } from './TerminalCard';
import { MarkdownCard } from './MarkdownCard';
import { KvCard } from './KvCard';
import { ErrorCard } from './ErrorCard';
import { JsonScalarCard } from './JsonScalarCard';
import { CodeCard } from './CodeCard';
import { DiffCard } from './DiffCard';
import { NotebookCard } from './NotebookCard';

// Each Card narrows `view` internally via Extract<ResultView, { kind: '...' }>.
type AnyCard = (props: { view: any; compact?: boolean }) => JSX.Element | null;

const RENDERERS: Record<ResultView['kind'], AnyCard> = {
  empty:    () => null,
  image:    ImageCard,
  terminal: TerminalCard,
  markdown: MarkdownCard,
  kv:       KvCard,
  error:    ErrorCard,
  json:     JsonScalarCard,
  // placeholders until later tasks — render via JsonScalarCard for now
  code:     CodeCard,
  diff:     DiffCard,
  paths:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  matches:  ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  search:   ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  page:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  github:   ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  click:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  keypress: ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  typed:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  tasks:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  notebook: NotebookCard,
  tree:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
};

export function ToolCardBody({ view, compact }: { view: ResultView; compact?: boolean }) {
  const Card = RENDERERS[view.kind];
  return Card ? <Card view={view} compact={compact} /> : null;
}
