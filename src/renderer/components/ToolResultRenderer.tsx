import type { ResultView } from '@shared/tool-presenters';
import { ToolCardBody } from '@renderer-shared/tool-cards';

export function ToolResultRenderer({ view, compact }: { view: ResultView; compact?: boolean }) {
  return <ToolCardBody view={view} compact={compact} />;
}
