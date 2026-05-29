import { useEffect, useRef, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

const DRAG_THRESHOLD_PX = 5;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const aspect = view.width && view.height ? view.width / view.height : null;
  const wide = aspect !== null && aspect > 2.5;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startScrollLeft: number; movedPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Esc to close lightbox
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // Translate vertical wheel to horizontal scroll on wide thumbnails
  useEffect(() => {
    if (!wide) return;
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wide]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!wide) return;
    const el = scrollerRef.current;
    if (!el) return;
    dragState.current = { startX: e.clientX, startScrollLeft: el.scrollLeft, movedPx: 0 };
    setDragging(true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragState.current || !scrollerRef.current) return;
    const dx = e.clientX - dragState.current.startX;
    dragState.current.movedPx = Math.max(dragState.current.movedPx, Math.abs(dx));
    scrollerRef.current.scrollLeft = dragState.current.startScrollLeft - dx;
  };
  const endDrag = () => {
    setDragging(false);
    // dragState stays around until click fires so onClick can read movedPx
    setTimeout(() => { dragState.current = null; }, 0);
  };
  const onClick = () => {
    const moved = dragState.current?.movedPx ?? 0;
    if (moved < DRAG_THRESHOLD_PX) setZoom(true);
  };

  const baseClasses = 'relative w-full rounded border border-border hover:border-accent transition-colors overflow-hidden bg-bg/40';
  const cursor = wide ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in';

  return (
    <>
      {wide ? (
        <div className="block w-full text-left">
          <div
            ref={scrollerRef}
            role="button"
            tabIndex={0}
            aria-label="View full size (drag to pan)"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            onClick={onClick}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setZoom(true); }}
            className={`${baseClasses} ${cursor} max-h-[280px] overflow-x-auto overflow-y-hidden select-none`}
          >
            <img
              src={view.src}
              alt={view.alt ?? 'screenshot'}
              draggable={false}
              loading="lazy"
              className="block max-h-[280px] w-auto max-w-none pointer-events-none"
            />
          </div>
          {view.meta && (
            <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'} flex items-center gap-2 flex-wrap`}>
              <span>{view.meta}</span>
              {view.path && (
                <span className="font-mono truncate text-muted/70" title={view.path}>
                  {view.path.split('/').pop()}
                </span>
              )}
              <span className="text-muted/60">· drag to pan, click for full size</span>
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setZoom(true)} aria-label="View full size"
                className="block w-full text-left group">
          <div className={`${baseClasses} max-h-[400px] group-hover:border-accent`}>
            <img src={view.src} alt={view.alt ?? 'screenshot'} loading="lazy"
                 className="block max-h-[400px] w-full object-contain mx-auto" />
          </div>
          {view.meta && (
            <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'} flex items-center gap-2 flex-wrap`}>
              <span>{view.meta}</span>
              {view.path && (
                <span className="font-mono truncate text-muted/70" title={view.path}>
                  {view.path.split('/').pop()}
                </span>
              )}
            </div>
          )}
        </button>
      )}
      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={view.alt ?? 'Image preview'}
             onClick={() => setZoom(false)}
             className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6 cursor-zoom-out overflow-auto">
          <img src={view.src} alt={view.alt ?? 'screenshot'} className="max-w-none max-h-none" />
        </div>
      )}
    </>
  );
}
