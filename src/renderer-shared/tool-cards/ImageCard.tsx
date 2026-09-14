import { useEffect, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

/**
 * Click reticles over the capture. Marker coords are virtual-desktop pixels;
 * the image spans (originX, originY)…(originX+width, originY+height) of the
 * same space and scales with its rendered box, so percentage positioning maps
 * a marker to the right pixel at any thumbnail size.
 */
function MarkerOverlay({ view }: { view: View }) {
  if (!view.markers || view.markers.length === 0) return null;
  if (view.width === undefined || view.height === undefined || view.width <= 0 || view.height <= 0) return null;
  const ox = view.originX ?? 0;
  const oy = view.originY ?? 0;
  return (
    <>
      {view.markers.map((m, i) => {
        const left = ((m.x - ox) / view.width!) * 100;
        const top = ((m.y - oy) / view.height!) * 100;
        if (left < 0 || left > 100 || top < 0 || top > 100) return null;
        return (
          <span
            key={i}
            data-testid="image-marker"
            className="absolute pointer-events-none z-[1]"
            style={{ left: `${left}%`, top: `${top}%` }}
          >
            <span aria-hidden className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/30 motion-safe:animate-ping" />
            <span aria-hidden className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent shadow-[0_0_10px_rgba(124,125,255,0.55)]" />
            {m.label && (
              <span className="absolute left-3.5 top-2 whitespace-nowrap rounded border border-accent/40 bg-bg/85 px-1 py-0.5 font-mono text-[9px] text-[#b9b9ff]">
                {m.label}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Escape closes zoom
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  // Escape or click-outside closes context menu
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

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const copyImage = async () => {
    try {
      const res = await fetch(view.src);
      const blob = await res.blob();
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

  return (
    <>
      <div className="block w-full text-left relative">
        <button
          type="button"
          onClick={() => setZoom(true)}
          onContextMenu={onContextMenu}
          aria-label="Click to zoom, right-click for options"
          className="block w-full text-left rounded border border-border hover:border-accent transition-colors bg-bg/40 cursor-zoom-in overflow-hidden"
        >
          {/* Relative wrapper sized by the img so percentage markers track the
              rendered image box (object-contain letterboxing would skew them). */}
          <span className="relative block w-fit max-w-full mx-auto">
            <img
              src={view.src}
              alt={view.alt ?? 'screenshot'}
              draggable={false}
              loading="lazy"
              className="block max-w-full h-auto max-h-[500px] pointer-events-none"
            />
            <MarkerOverlay view={view} />
          </span>
        </button>
        {view.meta && (
          <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'} flex items-center gap-2 flex-wrap`}>
            <span>{view.meta}</span>
            {view.path && (
              <span className="font-mono truncate text-muted/70" title={view.path}>
                {view.path.split('/').pop()}
              </span>
            )}
            <span className="text-muted/60">· click to zoom · right-click to copy</span>
          </div>
        )}
        {view.note && (
          <div
            data-testid="image-action-note"
            className="mt-1.5 rounded-[7px] border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-[10.5px] text-text/85"
          >
            {view.note}
          </div>
        )}
        {toast && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-accent text-bg text-[10.5px] font-medium shadow pointer-events-none z-10">
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
