import { useEffect, useRef, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

const DRAG_THRESHOLD_PX = 5;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startScrollLeft: number; movedPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    const onClick = () => setMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [menu]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(t);
  }, [toast]);

  // Translate vertical wheel → horizontal scroll when overflow exists
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // ignore right/middle for drag
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
    setTimeout(() => { dragState.current = null; }, 0);
  };
  const onClick = () => {
    const moved = dragState.current?.movedPx ?? 0;
    if (moved < DRAG_THRESHOLD_PX) setZoom(true);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const copyImage = async () => {
    try {
      const res = await fetch(view.src);
      const blob = await res.blob();
      // Most clipboards expect PNG. Re-wrap if needed.
      const type = blob.type || 'image/png';
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      setToast('Image copied');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ImageCard] copy image failed:', err);
      setToast('Copy failed');
    } finally {
      setMenu(null);
    }
  };

  const copyPath = async () => {
    if (!view.path) return;
    try {
      await navigator.clipboard.writeText(view.path);
      setToast('Path copied');
    } catch {
      setToast('Copy failed');
    } finally {
      setMenu(null);
    }
  };

  const cursor = dragging ? 'cursor-grabbing' : 'cursor-grab';

  return (
    <>
      <div className="block w-full text-left relative">
        <div
          ref={scrollerRef}
          role="button"
          tabIndex={0}
          aria-label="Drag to pan, click for full size, right-click for options"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onClick={onClick}
          onContextMenu={onContextMenu}
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
            <span className="text-muted/60">· drag to pan · click to zoom · right-click to copy</span>
          </div>
        )}
        {toast && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-accent text-bg text-[10.5px] font-medium shadow pointer-events-none">
            {toast}
          </div>
        )}
      </div>
      {menu && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 min-w-[160px] rounded border border-border bg-surface shadow-lg py-1 text-sm"
        >
          <button
            type="button"
            role="menuitem"
            onClick={copyImage}
            className="block w-full text-left px-3 py-1.5 hover:bg-bg/60"
          >
            Copy image
          </button>
          {view.path && (
            <button
              type="button"
              role="menuitem"
              onClick={copyPath}
              className="block w-full text-left px-3 py-1.5 hover:bg-bg/60"
            >
              Copy file path
            </button>
          )}
        </div>
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
