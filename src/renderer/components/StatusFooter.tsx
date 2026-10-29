import { Lock } from 'lucide-react';
import type { AutonomyMode } from '@shared/messages';
import { modelLabel } from '@shared/models';
import { ModeBadge } from './ModeBadge';

interface Props {
  model: string;
  sessionId: string | null;
  mode: AutonomyMode;
  isPrivate?: boolean;
}

export function StatusFooter({ model, sessionId, mode, isPrivate = false }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded-md bg-white/[0.04] border border-border" title={model}>
          {modelLabel(model)}
        </span>
        {isPrivate ? (
          <span
            data-testid="private-indicator"
            title="Private conversation — nothing here is saved to history, learned, or written to memory"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-[#7c7dff]/15 text-[#b9b9ff] border border-[#7c7dff]/40"
          >
            <Lock className="h-2.5 w-2.5" aria-hidden />
            private
          </span>
        ) : (
          sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>
        )}
      </div>
      <ModeBadge mode={mode} />
    </div>
  );
}
