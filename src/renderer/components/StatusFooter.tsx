import type { AutonomyMode } from '@shared/messages';
import { ModeBadge } from './ModeBadge';
import { ModelSwitcher } from './ModelSwitcher';

interface Props {
  model: string;
  sessionId: string | null;
  mode: AutonomyMode;
  onModelChange(id: string): void;
  modelLocked?: boolean;
}

export function StatusFooter({ model, sessionId, mode, onModelChange, modelLocked = false }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <ModelSwitcher value={model} onChange={onModelChange} disabled={modelLocked} />
        {sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>}
      </div>
      <ModeBadge mode={mode} />
    </div>
  );
}
