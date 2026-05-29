import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';
import type { TailnetEndpoint } from './tailnet';

export interface RemoteModuleBridge {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  mintPairingCode(): string;
  signScreenshotUrl(id: string): string;
}

export interface RemoteModuleStatus {
  running: boolean;
  url: string | null;
  reason: string | null;
  pairedCount: number;
}

export interface RemoteModuleOpts {
  pairing: PairingStore;
  bus: SessionBus;
  resolveTailnetEndpoint: () => Promise<TailnetEndpoint>;
  makeBridge: (tailnetIp: string) => RemoteModuleBridge;
  pollMs?: number;         // default 60_000
  restartDelayMs?: number; // default 1_000
}

const DEFAULT_POLL = 60_000;
const DEFAULT_RESTART = 1_000;

export class RemoteModule {
  private bridge: RemoteModuleBridge | null = null;
  private currentIp: string | null = null;
  private currentHost: string | null = null;
  private currentPort: number | null = null;
  private reason: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly opts: RemoteModuleOpts) {}

  async start(): Promise<void> {
    this.stopping = false;
    await this.bringUp();
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => { void this.poll(); }, pollMs);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    await this.tearDown();
  }

  // Returns a signed `/screenshot/<id>?...sig=...` URL routed through the
  // active bridge, or null when the bridge isn't running. Used by the
  // SessionBus fan-out to inject signedUrl onto screenshot-captured events so
  // remote clients (PWA) can fetch the image.
  signScreenshotUrl(id: string): string | null {
    if (!this.bridge) return null;
    try { return this.bridge.signScreenshotUrl(id); } catch { return null; }
  }

  mintPairingCode(): { code: string; url: string; expiresAt: number } {
    if (!this.bridge || !this.currentIp || !this.currentPort) {
      throw new Error('remote bridge not running');
    }
    const code = this.bridge.mintPairingCode();
    // Use the IP for the pairing URL when the hostname contains spaces or
    // non-ASCII characters that break URL parsing on the mobile client.
    const safeHost = this.currentHost && /^[a-zA-Z0-9._-]+$/.test(this.currentHost)
      ? this.currentHost
      : this.currentIp;
    return {
      code,
      url: `http://${safeHost}:${this.currentPort}/?code=${code}`,
      expiresAt: Date.now() + 120_000,
    };
  }

  status(): RemoteModuleStatus {
    const displayHost = this.currentHost ?? this.currentIp;
    return {
      running: this.bridge !== null && this.currentPort !== null,
      url: displayHost && this.currentPort ? `http://${displayHost}:${this.currentPort}` : null,
      reason: this.reason,
      pairedCount: this.opts.pairing.list().filter((d) => !d.revokedAt).length,
    };
  }

  private async bringUp(): Promise<void> {
    const ep = await this.opts.resolveTailnetEndpoint();
    if (!ep.ip) {
      this.reason = 'tailnet IP not detected';
      logger.warn(`remote: ${this.reason}`);
      return;
    }
    this.currentIp = ep.ip;
    this.currentHost = ep.host;
    this.reason = null;
    try {
      const bridge = this.opts.makeBridge(ep.ip);
      const { port } = await bridge.start();
      this.bridge = bridge;
      this.currentPort = port;
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn(`remote: bridge start failed: ${msg}`);
      this.reason = `bridge start failed: ${msg}`;
      this.bridge = null;
      this.currentPort = null;
      if (!this.stopping) {
        const delay = this.opts.restartDelayMs ?? DEFAULT_RESTART;
        setTimeout(() => { void this.retryOnce(); }, delay);
      }
    }
  }

  private async retryOnce(): Promise<void> {
    if (this.stopping || this.bridge) return;
    const ip = this.currentIp;
    if (!ip) return;
    try {
      const bridge = this.opts.makeBridge(ip);
      const { port } = await bridge.start();
      this.bridge = bridge;
      this.currentPort = port;
      this.reason = null;
    } catch (err) {
      const msg = (err as Error).message;
      this.reason = `bridge restart failed: ${msg}`;
      logger.warn(`remote: ${this.reason} (giving up; stays down)`);
    }
  }

  private async tearDown(): Promise<void> {
    const b = this.bridge;
    this.bridge = null;
    this.currentPort = null;
    if (b) await b.stop().catch(() => {});
  }

  private async poll(): Promise<void> {
    if (this.stopping) return;
    const ep = await this.opts.resolveTailnetEndpoint();
    if (ep.ip !== this.currentIp || ep.host !== this.currentHost) {
      logger.info(`remote: tailnet endpoint changed (${this.currentHost ?? this.currentIp} -> ${ep.host ?? ep.ip}); rebinding`);
      await this.tearDown();
      this.currentIp = ep.ip;
      this.currentHost = ep.host;
      if (ep.ip) await this.bringUp();
    }
  }
}
