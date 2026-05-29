import { useEffect, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

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
          <img
            src={view.src}
            alt={view.alt ?? 'screenshot'}
            draggable={false}
            loading="lazy"
            className="block w-full h-auto max-h-[500px] object-contain pointer-events-none"
          />
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
