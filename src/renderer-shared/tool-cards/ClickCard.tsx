import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'click' }>;

export function ClickCard({ view, compact }: { view: View; compact?: boolean }) {
  const W = compact ? 180 : 240, H = compact ? 100 : 130;
  const px = Math.min(Math.max(view.x / 2560, 0), 1) * W;
  const py = Math.min(Math.max(view.y / 1440, 0), 1) * H;
  return (
    <div>
      <div className="text-muted text-[10.5px] mb-1.5">
        clicked at ({view.x}, {view.y}){view.button ? ` · ${view.button}` : ''}
      </div>
      <div className="relative rounded bg-gradient-to-br from-surface/60 to-bg/80 overflow-hidden border border-border/40"
           style={{ width: W, height: H }}>
        <div className="absolute inset-x-0" style={{ top: py, height: 1, background: 'rgba(120,180,255,.4)' }} />
        <div className="absolute inset-y-0" style={{ left: px, width: 1, background: 'rgba(120,180,255,.4)' }} />
        <div className="absolute rounded-full bg-accent"
             style={{ left: px - 5, top: py - 5, width: 10, height: 10, boxShadow: '0 0 10px var(--accent, #9ec5ff)' }} />
      </div>
    </div>
  );
}
