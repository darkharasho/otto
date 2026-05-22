import type { AutonomyMode } from '@shared/messages';
import { ModeBadge } from './ModeBadge';

interface Props {
  model: string;
  sessionId: string | null;
  streaming: boolean;
  mode: AutonomyMode;
}

export function StatusFooter({ model, sessionId, streaming, mode }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-bg/60 border border-border">{model}</span>
        {sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>}
      </div>
      <div className="flex items-center gap-3">
        <ModeBadge mode={mode} />
        <div>{streaming ? 'thinking…' : ''}</div>
      </div>
    </div>
  );
}
