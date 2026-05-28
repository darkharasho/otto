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
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} aria-label="View full size"
              className="block w-full text-left">
        <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
             className="max-w-full rounded border border-border hover:border-accent transition-colors" />
        {view.meta && (
          <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>{view.meta}</div>
        )}
      </button>
      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={view.alt ?? 'Image preview'}
             onClick={() => setZoom(false)}
             className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out">
          <img src={view.src} alt={view.alt ?? 'tool result'} className="max-w-full max-h-full" />
        </div>
      )}
    </>
  );
}
