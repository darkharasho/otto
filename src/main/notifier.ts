import { Notification, app } from 'electron';
import path from 'node:path';
import type { SessionEvent } from '@shared/ipc-contract';
import { logger } from './logger';

interface Deps {
  isMainFocused(): boolean;
  showMain(): void;
  shouldNotifyTurnComplete(): boolean;
  shouldNotifyApproval(): boolean;
  silent(): boolean;
}

const TRUNCATE = 120;

function truncate(s: string, n = TRUNCATE): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    try {
      return truncate(JSON.stringify(input));
    } catch {
      return '[unserializable]';
    }
  }
  return String(input ?? '');
}

export class Notifier {
  // Track per-session text accumulators so turn-complete notifications can
  // include a short preview of what Otto said.
  private lastText = new Map<string, string>();
  // Skip the first 'done' before any text/tool activity so we don't fire on
  // empty turns or the initial session-start handshake.
  private hadActivity = new Set<string>();

  constructor(private readonly deps: Deps) {}

  handle(event: SessionEvent): void {
    if (!Notification.isSupported()) return;

    switch (event.type) {
      case 'text-delta': {
        this.lastText.set(event.sessionId, (this.lastText.get(event.sessionId) ?? '') + event.text);
        this.hadActivity.add(event.sessionId);
        return;
      }
      case 'tool-call-start':
      case 'tool-call-result':
        this.hadActivity.add(event.sessionId);
        return;
      case 'tool-call-pending': {
        if (!this.deps.shouldNotifyApproval()) return;
        this.notifyApproval(event);
        return;
      }
      case 'message-cancelled':
      case 'error': {
        // Reset state but don't notify on cancel/error — the in-window UI
        // makes that obvious; an OS toast would be noise.
        this.lastText.delete(event.sessionId);
        this.hadActivity.delete(event.sessionId);
        return;
      }
      case 'done': {
        const preview = this.lastText.get(event.sessionId)?.trim() ?? '';
        const had = this.hadActivity.has(event.sessionId);
        this.lastText.delete(event.sessionId);
        this.hadActivity.delete(event.sessionId);
        if (!had) return;
        if (!this.deps.shouldNotifyTurnComplete()) return;
        if (this.deps.isMainFocused()) return;
        this.notifyTurnComplete(preview);
        return;
      }
      default:
        return;
    }
  }

  private notifyTurnComplete(preview: string): void {
    const body = preview ? truncate(preview.replace(/\s+/g, ' ')) : 'Tap to view the response.';
    this.show({ title: 'Otto finished', body });
  }

  private notifyApproval(event: Extract<SessionEvent, { type: 'tool-call-pending' }>): void {
    const body = `${event.name} — ${event.actionClass}\n${truncate(summarizeInput(event.input), 100)}`;
    this.show({ title: 'Otto needs approval', body, urgency: 'critical' });
  }

  notifyUpdateAvailable(version: string, onClick: () => void): void {
    if (!Notification.isSupported()) return;
    if (this.deps.silent()) return;
    try {
      const n = new Notification({
        title: 'Otto update available',
        body: `Otto ${version} is ready to download. Click to install.`,
        icon: this.iconPath(),
      });
      n.on('click', onClick);
      n.show();
    } catch (err) {
      logger.warn(`notification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  notifyUpdateReady(version: string, onClick: () => void): void {
    if (!Notification.isSupported()) return;
    if (this.deps.silent()) return;
    try {
      const n = new Notification({
        title: 'Otto update ready',
        body: `Otto ${version} will install when you quit. Click to install now.`,
        icon: this.iconPath(),
      });
      n.on('click', onClick);
      n.show();
    } catch (err) {
      logger.warn(`notification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private show(args: { title: string; body: string; urgency?: 'low' | 'normal' | 'critical' }): void {
    try {
      const n = new Notification({
        title: args.title,
        body: args.body,
        silent: this.deps.silent(),
        urgency: args.urgency ?? 'normal',
        icon: this.iconPath(),
      });
      n.on('click', () => this.deps.showMain());
      n.show();
    } catch (err) {
      logger.warn(`notification failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private iconPath(): string {
    return path.join(app.getAppPath(), 'public', 'tray', 'tray-icon@2x.png');
  }
}
