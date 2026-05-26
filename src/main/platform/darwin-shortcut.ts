import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';

/**
 * Thin wrapper around the native darwin_shortcut.node addon. Uses a CGEvent
 * tap to intercept global keyboard shortcuts.
 *
 * Requires Accessibility permission:
 *   - Prod (signed app): macOS prompts automatically.
 *   - Dev: manually add Electron.app in System Settings > Privacy & Security > Accessibility.
 */

interface DarwinShortcutModule {
  register(combo: string, callback: () => void): boolean;
  unregister(): void;
  isAccessibilityTrusted(): boolean;
  promptAccessibility(): boolean;
}

let mod: DarwinShortcutModule | null = null;

function getModule(): DarwinShortcutModule {
  if (mod) return mod;
  // The .node binary lives in src/native/build/Release/ during dev,
  // and is unpacked alongside the app in prod.
  const candidates = [
    path.join(app.getAppPath(), 'src', 'native', 'build', 'Release', 'darwin_shortcut.node'),
    path.join(app.getAppPath(), 'native', 'darwin_shortcut.node'),
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(p) as DarwinShortcutModule;
      return mod;
    } catch {
      // try next
    }
  }
  throw new Error('darwin_shortcut.node not found — run: cd src/native && npx node-gyp rebuild');
}

export function isAccessibilityTrusted(): boolean {
  try {
    return getModule().isAccessibilityTrusted();
  } catch (err) {
    logger.warn(`darwin-shortcut: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export function promptAccessibility(): boolean {
  try {
    return getModule().promptAccessibility();
  } catch (err) {
    logger.warn(`darwin-shortcut: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export function registerDarwinShortcut(combo: string, callback: () => void): boolean {
  try {
    const m = getModule();
    const ok = m.register(combo, callback);
    if (ok) {
      logger.info(`darwin-shortcut: registered CGEvent tap for ${combo}`);
    } else {
      logger.warn(`darwin-shortcut: CGEvent tap registration returned false for ${combo} (Accessibility permission missing?)`);
    }
    return ok;
  } catch (err) {
    logger.warn(`darwin-shortcut: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export function unregisterDarwinShortcut(): void {
  try {
    getModule().unregister();
  } catch {
    // ignore
  }
}
