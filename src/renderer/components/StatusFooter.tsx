import type { AutonomyMode } from '@shared/messages';
import { ModeBadge } from './ModeBadge';

interface Props {
  model: string;
  sessionId: string | null;
  mode: AutonomyMode;
}

// Short label for the active model id. Falls back to the raw id.
function modelLabel(id: string): string {
  if (id.includes('opus')) return 'Opus 4.7';
  if (id.includes('sonnet')) return 'Sonnet 4.6';
  if (id.includes('haiku')) return 'Haiku 4.5';
  return id;
}

export function StatusFooter({ model, sessionId, mode }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-bg/60 border border-border" title={model}>
          {modelLabel(model)}
        </span>
        {sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>}
      </div>
      <ModeBadge mode={mode} />
    </div>
  );
}
