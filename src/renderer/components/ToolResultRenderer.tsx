import type { ResultView } from '@shared/tool-presenters';
import { ToolCardBody } from '@renderer-shared/tool-cards';

export function ToolResultRenderer({ view, compact, onStop }: { view: ResultView; compact?: boolean; onStop?: () => void }) {
  return <ToolCardBody view={view} compact={compact} onStop={onStop} />;
}
