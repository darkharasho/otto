import { BrowserWindow } from 'electron';

// Linux is the awkward case: Electron's setOpacity() is a no-op on Linux, so
// we have to actually hide() the window. On KWin/Wayland, show()/showInactive()
// after hide() frequently fails to re-map the surface — the workaround is to
// re-assert alwaysOnTop and call show() (not showInactive), which forces the
// compositor to re-map. On macOS/Windows we use opacity so focus stays put.
const SETTLE_MS = process.platform === 'linux' ? 120 : 60;

type Masked = {
  win: BrowserWindow;
  method: 'opacity' | 'hide';
  prevOpacity: number;
};

export async function withSelfHidden<T>(fn: () => Promise<T>): Promise<T> {
  const masked: Masked[] = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w.isVisible())
    .map((w) => ({
      win: w,
      method: process.platform === 'linux' ? 'hide' : 'opacity',
      prevOpacity: w.getOpacity(),
    }));
  if (masked.length === 0) return fn();
  for (const m of masked) {
    if (m.method === 'opacity') m.win.setOpacity(0);
    else m.win.hide();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
  try {
    return await fn();
  } finally {
    for (const m of masked) {
      if (m.win.isDestroyed()) continue;
      if (m.method === 'opacity') {
        m.win.setOpacity(m.prevOpacity);
      } else {
        // KWin/Wayland needs the layer re-asserted or show() may be a no-op.
        m.win.setAlwaysOnTop(true, 'floating');
        m.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        m.win.show();
      }
    }
  }
}
