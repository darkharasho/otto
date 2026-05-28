import type { ResultView } from '../shared/tool-presenters';
import { ToolCardBody } from '../renderer-shared/tool-cards';

export function ToolResultRenderer({ view }: { view: ResultView }) {
  return <ToolCardBody view={view} compact />;
}
