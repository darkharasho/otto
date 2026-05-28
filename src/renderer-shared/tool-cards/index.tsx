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
import { PathsCard } from './PathsCard';
import { MatchesCard } from './MatchesCard';
import { SearchCard } from './SearchCard';
import { PageCard } from './PageCard';
import { GithubCard } from './GithubCard';
import { ClickCard } from './ClickCard';
import { KeyCapsCard } from './KeyCapsCard';
import { TypedCard } from './TypedCard';
import { TasksCard } from './TasksCard';
import { JsonTreeCard } from './JsonTreeCard';

// Each Card narrows `view` internally via Extract<ResultView, { kind: '...' }>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  paths:    PathsCard,
  matches:  MatchesCard,
  search:   SearchCard,
  page:     PageCard,
  github:   GithubCard,
  click:    ClickCard,
  keypress: KeyCapsCard,
  typed:    TypedCard,
  tasks:    TasksCard,
  notebook: NotebookCard,
  tree:     JsonTreeCard,
};

export function ToolCardBody({ view, compact }: { view: ResultView; compact?: boolean }) {
  const Card = RENDERERS[view.kind];
  return Card ? <Card view={view} compact={compact} /> : null;
}
