import { useEffect, useRef, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

const DRAG_THRESHOLD_PX = 5;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startScrollLeft: number; movedPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Detect horizontal overflow on mount / image load to decide cursor + hint
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    const img = el.querySelector('img');
    if (img) img.addEventListener('load', check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      if (img) img.removeEventListener('load', check);
      ro.disconnect();
    };
  }, [view.src]);

  // Esc closes lightbox
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // Translate vertical wheel → horizontal scroll while hovering
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!overflows) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [overflows]);

  const onMouseDown = (e: React.MouseEvent) => {
    const el = scrollerRef.current;
    if (!el) return;
    dragState.current = { startX: e.clientX, startScrollLeft: el.scrollLeft, movedPx: 0 };
    setDragging(true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragState.current || !scrollerRef.current) return;
    if (!overflows) return;
    const dx = e.clientX - dragState.current.startX;
    dragState.current.movedPx = Math.max(dragState.current.movedPx, Math.abs(dx));
    scrollerRef.current.scrollLeft = dragState.current.startScrollLeft - dx;
  };
  const endDrag = () => {
    setDragging(false);
    setTimeout(() => { dragState.current = null; }, 0);
  };
  const onClick = () => {
    const moved = dragState.current?.movedPx ?? 0;
    if (moved < DRAG_THRESHOLD_PX) setZoom(true);
  };

  const cursor = overflows ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in';

  return (
    <>
      <div className="block w-full text-left">
        <div
          ref={scrollerRef}
          role="button"
          tabIndex={0}
          aria-label={overflows ? 'Drag to pan, click for full size' : 'View full size'}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onClick={onClick}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setZoom(true); }}
          className={`relative w-full rounded border border-border hover:border-accent transition-colors bg-bg/40 overflow-x-auto overflow-y-hidden select-none max-h-[400px] ${cursor}`}
        >
          <img
            src={view.src}
            alt={view.alt ?? 'screenshot'}
            draggable={false}
            loading="lazy"
            className="block max-h-[400px] w-auto max-w-none pointer-events-none"
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
            {overflows && (
              <span className="text-muted/60">· drag to pan</span>
            )}
          </div>
        )}
      </div>
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
