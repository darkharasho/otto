import type { ResultView } from '@shared/tool-presenters';
import { ToolCardBody } from '@renderer-shared/tool-cards';
import { DelegationView } from './DelegationView';

export function ToolResultRenderer({ view, compact, onStop }: { view: ResultView; compact?: boolean; onStop?: () => void }) {
  if (view.kind === 'delegation') return <DelegationView snapshot={view.snapshot} />;
  return <ToolCardBody view={view} compact={compact} onStop={onStop} />;
}
