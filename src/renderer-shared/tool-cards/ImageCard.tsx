import { useEffect, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);
  const aspect = view.width && view.height ? view.width / view.height : null;
  // For very wide images (multi-monitor), letterbox in a tall-ish thumbnail rather than
  // shrinking to a sliver. For normal aspect images, use natural scaling capped by max-h.
  const wide = aspect !== null && aspect > 2.5;
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} aria-label="View full size"
              className="block w-full text-left group">
        <div className={`relative w-full rounded border border-border group-hover:border-accent transition-colors overflow-hidden bg-bg/40 ${wide ? 'max-h-[280px]' : 'max-h-[400px]'}`}>
          <img src={view.src} alt={view.alt ?? 'screenshot'} loading="lazy"
               className={`w-full h-auto ${wide ? 'object-contain max-h-[280px]' : 'object-contain max-h-[400px]'} mx-auto`} />
        </div>
        {view.meta && (
          <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'} flex items-center gap-2 flex-wrap`}>
            <span>{view.meta}</span>
            {view.path && (
              <span className="font-mono truncate text-muted/70" title={view.path}>{view.path.split('/').pop()}</span>
            )}
          </div>
        )}
      </button>
      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={view.alt ?? 'Image preview'}
             onClick={() => setZoom(false)}
             className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6 cursor-zoom-out">
          <img src={view.src} alt={view.alt ?? 'screenshot'} className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </>
  );
}
