/**
 * Distinguishes the dev build (run via `electron-vite dev`) from a packaged
 * install so the two can coexist on the same machine without colliding over
 * the config dir, IPC socket, autostart entry, or global hotkey.
 *
 * The dev signal must work before `electron` is imported (logger.ts loads
 * early), so we read env vars rather than calling `app.isPackaged`.
 */
export function isDevInstance(): boolean {
  if (process.env.OTTO_DEV === '1') return true;
  if (process.env.NODE_ENV === 'development') return true;
  if (process.env.ELECTRON_RENDERER_URL) return true;
  return false;
}

export function instanceSuffix(): string {
  return isDevInstance() ? '-dev' : '';
}

export function instanceDisplayName(): string {
  return isDevInstance() ? 'Otto Dev' : 'Otto';
}
