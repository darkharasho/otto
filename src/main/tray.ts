import { Tray, Menu, nativeImage, app, type NativeImage } from 'electron';
import path from 'node:path';
import { logger } from './logger';
import { instanceDisplayName, isDevInstance } from './instance';

export interface TrayActions {
  onShow(): void;
  onOpenSettings(): void;
  onQuit(): void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private badged = false;

  constructor(private readonly actions: TrayActions) {}

  notifyLearned(count: number): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Notification } = require('electron') as typeof import('electron');
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: `${instanceDisplayName()} learned ${count === 1 ? '1 new thing' : `${count} new things`}`,
        body: 'Open Memory to review.',
        silent: true,
      });
      n.on('click', () => this.actions.onOpenSettings());
      n.show();
    } catch (err) {
      logger.warn(`tray notifyLearned failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  setBadged(badged: boolean): void {
    if (this.badged === badged) return;
    this.badged = badged;
    if (!this.tray) return;
    try {
      const img = nativeImage.createFromPath(this.iconPath());
      if (!img.isEmpty()) this.tray.setImage(img);
    } catch (err) {
      logger.warn(`tray setImage failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  start(): void {
    let icon: NativeImage;
    try {
      icon = nativeImage.createFromPath(this.iconPath());
      if (icon.isEmpty()) {
        logger.warn(`tray icon empty at ${this.iconPath()}`);
        return;
      }
    } catch (err) {
      logger.warn(`tray icon load failed: ${err instanceof Error ? err.message : err}`);
      return;
    }

    try {
      this.tray = new Tray(icon);
    } catch (err) {
      // Some Linux compositors (e.g. plain Wayland without an appindicator
      // shim) reject Tray creation. Log and degrade gracefully — the rest of
      // Otto works without it.
      logger.warn(`tray init failed: ${err instanceof Error ? err.message : err}`);
      return;
    }

    this.tray.setToolTip(instanceDisplayName());
    this.refreshMenu();
    // Left-click on the tray shows the bar (matches the hotkey).
    this.tray.on('click', () => this.actions.onShow());
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const name = instanceDisplayName();
    const menu = Menu.buildFromTemplate([
      { label: `Show ${name}`, click: () => this.actions.onShow() },
      { type: 'separator' },
      { label: 'Settings…', click: () => this.actions.onOpenSettings() },
      { type: 'separator' },
      { label: `Quit ${name}`, click: () => this.actions.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private iconPath(): string {
    // Same path resolves in dev (run from repo root) and in packaged build
    // (app.getAppPath() points at app.asar root which has public/tray bundled
    // per electron-builder.yml).
    const base = isDevInstance() ? 'tray-icon-dev' : 'tray-icon';
    const file = this.badged ? `${base}-badge.png` : `${base}.png`;
    return path.join(app.getAppPath(), 'public', 'tray', file);
  }
}
