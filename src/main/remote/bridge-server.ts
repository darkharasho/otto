import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';
import { ScreenshotUrlSigner } from './screenshot-urls';

export interface BridgeServerOpts {
  tailnetIp: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
  activeSessionId?: () => string | null;
  screenshotSecret: string;
  loadScreenshot: (id: string) => Promise<Buffer | null>;
  resolveApproval?: (decisionId: string, choice: 'approve' | 'deny') => boolean;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

export class BridgeServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly codes = new Map<string, PairingCode>();
  private readonly PAIR_TTL_MS = 120_000;
  private readonly pairHits = new Map<string, number[]>();
  private readonly PAIR_WINDOW_MS = 60_000;
  private readonly PAIR_MAX = 10;

  private rateLimited(req: http.IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const arr = (this.pairHits.get(ip) ?? []).filter((t) => now - t < this.PAIR_WINDOW_MS);
    if (arr.length >= this.PAIR_MAX) { this.pairHits.set(ip, arr); return true; }
    arr.push(now);
    this.pairHits.set(ip, arr);
    return false;
  }

  private readonly signer: ScreenshotUrlSigner;

  constructor(private readonly opts: BridgeServerOpts) {
    this.signer = new ScreenshotUrlSigner(opts.screenshotSecret);
  }

  signScreenshotUrl(id: string): string { return this.signer.sign(id); }

  async start(): Promise<{ port: number }> {
    if (!this.opts.tailnetIp) {
      throw new Error('tailnet IP not available; refusing to bind to 0.0.0.0 or 127.0.0.1');
    }
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.opts.tailnetIp!, () => resolve());
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.handleWs(ws, req));
    logger.info(`remote bridge listening on http://${this.opts.tailnetIp}:${port}`);
    return { port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (this.wss) { this.wss.close(); this.wss = null; }
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private handleWs(ws: WebSocket, _req: http.IncomingMessage): void {
    let authed = false;
    let device: { id: string; label: string } | null = null;
    let unsub: null | (() => void) = null;

    const close = (code: number, reason: string) => { try { ws.close(code, reason); } catch { /* ws may already be torn down */ } };

    ws.on('message', async (data) => {
      let msg: { v?: number; type?: string; [k: string]: unknown };
      try { msg = JSON.parse(data.toString()); } catch { return close(1003, 'bad json'); }
      if (!authed) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return close(4001, 'auth_failed: first frame must be auth');
        const found = await this.opts.pairing.verify(msg.token);
        if (!found) return close(4001, 'auth_failed');
        authed = true;
        device = { id: found.id, label: found.label };
        ws.send(JSON.stringify({ v: 1, type: 'auth_ok', deviceLabel: found.label }));
        const sid = this.opts.activeSessionId?.() ?? null;
        if (sid) {
          unsub = this.opts.bus.subscribe(sid, (e) => {
            try { ws.send(JSON.stringify({ v: 1, ...e })); } catch { /* ws may be closed */ }
          });
        }
        return;
      }
      if (msg.type === 'prompt' && typeof msg.sessionId === 'string' && typeof msg.text === 'string') {
        void this.opts.bus.enqueueInput(msg.sessionId, { type: 'prompt', sessionId: msg.sessionId, text: msg.text, origin: 'remote' });
        return;
      }
      if (msg.type === 'interrupt' && typeof msg.sessionId === 'string') {
        void this.opts.bus.enqueueInput(msg.sessionId, { type: 'interrupt', sessionId: msg.sessionId });
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ v: 1, type: 'pong' })); return; }
      if (msg.type === 'approval' && typeof msg.decisionId === 'string' && (msg.decision === 'approve' || msg.decision === 'deny')) {
        this.opts.resolveApproval?.(msg.decisionId, msg.decision);
        return;
      }
    });

    ws.on('close', () => { const fn = unsub as (() => void) | null; if (fn) fn(); });
    // expose `device` and `unsub` via closure for subsequent tasks
    void device;
    void unsub;
  }

  mintPairingCode(now: number = Date.now()): string {
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { code, expiresAt: now + this.PAIR_TTL_MS });
    return code;
  }

  private async readJson<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'POST' && req.url === '/pair') return await this.handlePair(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/history')) return await this.handleHistory(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/screenshot/')) return await this.handleScreenshot(req, res);
      // Fall through to PWA static serving for any unmatched GET when a pwaDir
      // is configured. Reserved API prefixes above are matched first so the
      // bridge wire still works even if a static file happens to share a name.
      if (req.method === 'GET' && this.opts.pwaDir) return await this.handleStatic(req, res);
      res.statusCode = 404;
      res.end('not found');
    } catch (err) {
      logger.warn(`bridge: handler error: ${(err as Error).message}`);
      res.statusCode = 500;
      res.end('internal error');
    }
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.rateLimited(req)) { res.statusCode = 429; res.end('too many requests'); return; }
    const body = await this.readJson<{ code: string; deviceLabel?: string }>(req);
    const entry = this.codes.get(body.code);
    const now = Date.now();
    if (!entry || entry.expiresAt < now) {
      res.statusCode = 401;
      res.end('invalid code');
      return;
    }
    this.codes.delete(body.code);
    const { deviceId, token } = await this.opts.pairing.issue(body.deviceLabel ?? 'iPhone');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token, deviceId, wsUrl: `/ws` }));
  }

  private async handleScreenshot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const result = this.signer.verify(req.url!);
    if (!result.ok || !result.id) { res.statusCode = 401; res.end('bad url'); return; }
    const buf = await this.opts.loadScreenshot(result.id);
    if (!buf) { res.statusCode = 404; res.end('not found'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.end(buf);
  }

  private static readonly MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map':  'application/json; charset=utf-8',
    '.txt':  'text/plain; charset=utf-8',
  };

  private async handleStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const root = this.opts.pwaDir!;
    const url = new URL(req.url ?? '/', 'http://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel = nodePath.join(rel, 'index.html');
    const resolved = nodePath.resolve(root, rel);
    // Prevent path traversal.
    if (!resolved.startsWith(nodePath.resolve(root) + nodePath.sep) && resolved !== nodePath.resolve(root, 'index.html')) {
      // Still allow files directly inside root (no sep when root === resolved).
      if (nodePath.dirname(resolved) !== nodePath.resolve(root) && !resolved.startsWith(nodePath.resolve(root) + nodePath.sep)) {
        res.statusCode = 403; res.end('forbidden'); return;
      }
    }
    try {
      const buf = await fsp.readFile(resolved);
      const ext = nodePath.extname(resolved).toLowerCase();
      res.statusCode = 200;
      res.setHeader('content-type', BridgeServer.MIME[ext] ?? 'application/octet-stream');
      res.end(buf);
    } catch {
      // SPA fallback: serve index.html for routes that don't map to a file.
      try {
        const buf = await fsp.readFile(nodePath.join(root, 'index.html'));
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(buf);
      } catch {
        res.statusCode = 404; res.end('not found');
      }
    }
  }

  private async handleHistory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
    const url = new URL(req.url!, 'http://x');
    const sid = url.searchParams.get('session_id') ?? '';
    const since = Number(url.searchParams.get('since') ?? '0');
    const out = this.opts.bus.history(sid, isFinite(since) ? since : 0);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  }
}
