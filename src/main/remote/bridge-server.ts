import http from 'node:http';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';
import type { ContentBlock, Message, SessionMeta } from '@shared/messages';
import { ScreenshotUrlSigner } from './screenshot-urls';
import { resolveImageRequest } from '../screenshot/protocol';

type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;
type StagedEntry = { ref: ImageRef; t: number };

function generateSelfSignedCert(ips: string[], dnsNames: string[] = []): { key: string; cert: string } {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'otto-cert-'));
  const keyPath = nodePath.join(dir, 'key.pem');
  const certPath = nodePath.join(dir, 'cert.pem');
  const san = [
    ...ips.map(ip => `IP:${ip}`),
    ...dnsNames.map(name => `DNS:${name}`),
  ].join(',');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=Otto Bridge" -addext "subjectAltName=${san}" 2>/dev/null`,
  );
  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8'),
  };
}

/**
 * Load a self-signed cert from <configDir>/remote-cert/ that matches the
 * current SAN inputs, regenerating it if missing, stale, or for different
 * IPs/hosts. Persistence is what lets a browser cert exception survive Otto
 * restarts — without it, every restart rotates the cert and the user gets
 * the warning page again (and silent WSS failures from the old exception).
 */
function loadOrCreateCert(configDir: string, ips: string[], dnsNames: string[]): { key: string; cert: string } {
  const certDir = nodePath.join(configDir, 'remote-cert');
  const keyPath = nodePath.join(certDir, 'key.pem');
  const certPath = nodePath.join(certDir, 'cert.pem');
  const metaPath = nodePath.join(certDir, 'meta.json');
  const sanKey = JSON.stringify({ ips: [...ips].sort(), dnsNames: [...dnsNames].sort() });

  if (existsSync(keyPath) && existsSync(certPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { san?: string };
      if (meta.san === sanKey) {
        return {
          key: readFileSync(keyPath, 'utf8'),
          cert: readFileSync(certPath, 'utf8'),
        };
      }
    } catch { /* fall through to regenerate */ }
  }

  const { key, cert } = generateSelfSignedCert(ips, dnsNames);
  mkdirSync(certDir, { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(certPath, cert);
  writeFileSync(metaPath, JSON.stringify({ san: sanKey }));
  return { key, cert };
}

export interface BridgeServerOpts {
  tailnetIp: string | null;
  tailnetHost?: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
  activeSessionId?: () => string | null;
  screenshotSecret: string;
  loadScreenshot: (id: string) => Promise<Buffer | null>;
  /** Optional image cache for inline-image markdown. When unset, /image returns 404. */
  imageCache?: { get(url: string): Promise<{ path: string; contentType: string }> };
  resolveApproval?: (decisionId: string, choice: 'approve' | 'deny') => boolean;
  resolveSudo?: (promptId: string, password: string | null) => boolean;
  sendPrompt?: (text: string, origin: 'desktop' | 'remote', attachments: ImageRef[]) => Promise<void>;
  interruptTurn?: (sessionId?: string) => void;
  listSessions?: (limit: number) => Promise<SessionMeta[]>;
  loadMessages?: (sessionId: string) => Promise<Message[]>;
  switchSession?: (sessionId: string) => Promise<void>;
  newSession?: () => Promise<string>;
  /** Preferred TCP port to bind. Falls back to an ephemeral port if in use. Default: ephemeral (0); production callers pass 17829. */
  port?: number;
  /** Directory where Otto config/data is stored; used to persist user-uploaded images. */
  configDir?: string;
  /** When true, serve plain HTTP instead of HTTPS. The tailnet already
   *  provides encryption + authentication, and self-signed HTTPS breaks
   *  desktop browsers' WSS handshake. */
  plainHttp?: boolean;
  /** When true, bind to 0.0.0.0 (all interfaces) and expose POST /dev/mint
   *  for CLI-driven pairing. Used by the iOS simulator and integration tests;
   *  never enabled in production. */
  devEndpoints?: boolean;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

export class BridgeServer {
  private server: http.Server | https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly codes = new Map<string, PairingCode>();
  private readonly PAIR_TTL_MS = 120_000;
  private readonly pairHits = new Map<string, number[]>();
  private readonly PAIR_WINDOW_MS = 60_000;
  private readonly PAIR_MAX = 10;
  /** Per-session staging map: sessionId -> (refId -> StagedEntry). Cleared as refs are consumed by prompts. */
  private readonly stagedAttachments = new Map<string, Map<string, StagedEntry>>();
  private static readonly STAGED_TTL_MS = 10 * 60 * 1000; // 10 minutes

  private rateLimited(req: http.IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const arr = (this.pairHits.get(ip) ?? []).filter((t) => now - t < this.PAIR_WINDOW_MS);
    if (arr.length >= this.PAIR_MAX) { this.pairHits.set(ip, arr); return true; }
    arr.push(now);
    this.pairHits.set(ip, arr);
    return false;
  }

  private static readonly DEFAULT_PORT = 0;

  private readonly signer: ScreenshotUrlSigner;

  constructor(private readonly opts: BridgeServerOpts) {
    this.signer = new ScreenshotUrlSigner(opts.screenshotSecret);
  }

  signScreenshotUrl(id: string): string { return this.signer.sign(id); }

  private sweepStagedAttachments(): void {
    const cutoff = Date.now() - BridgeServer.STAGED_TTL_MS;
    for (const [sid, m] of this.stagedAttachments) {
      for (const [id, entry] of m) {
        if (entry.t < cutoff) m.delete(id);
      }
      if (m.size === 0) this.stagedAttachments.delete(sid);
    }
  }

  get isPlainHttp(): boolean { return this.opts.plainHttp === true; }

  async start(): Promise<{ port: number }> {
    if (!this.opts.tailnetIp) {
      throw new Error('tailnet IP not available; refusing to bind to 0.0.0.0 or 127.0.0.1');
    }
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handle(req, res);
    };
    let server: http.Server | https.Server;
    if (this.opts.plainHttp) {
      server = http.createServer(handler);
      logger.info('remote bridge: plain HTTP mode (TLS disabled)');
    } else {
      const dnsNames = this.opts.tailnetHost ? [this.opts.tailnetHost] : [];
      const ips = [this.opts.tailnetIp, '127.0.0.1'];
      const { key, cert } = this.opts.configDir
        ? loadOrCreateCert(this.opts.configDir, ips, dnsNames)
        : generateSelfSignedCert(ips, dnsNames);
      server = https.createServer({ key, cert }, handler);
    }
    const desiredPort = this.opts.port ?? BridgeServer.DEFAULT_PORT;
    const bindAddr = this.opts.devEndpoints ? '0.0.0.0' : this.opts.tailnetIp!;
    const tryListen = (p: number) => new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { code?: string }) => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(p, bindAddr, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    try {
      await tryListen(desiredPort);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE' && desiredPort !== 0) {
        logger.warn(`bridge: port ${desiredPort} in use, falling back to ephemeral`);
        await tryListen(0);
      } else {
        throw err;
      }
    }
    this.server = server;
    const { port } = server.address() as AddressInfo;
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.handleWs(ws, req));
    const scheme = this.opts.plainHttp ? 'http' : 'https';
    logger.info(`remote bridge listening on ${scheme}://${this.opts.tailnetIp}:${port}`);
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
        // Subscribe to events for ALL sessions: the phone may connect before
        // any session exists, and we want to receive whichever sessions are
        // currently or subsequently active. We include `sessionId` on every
        // outbound frame so the PWA can route by session.
        unsub = this.opts.bus.subscribeAll((sid, e) => {
          try { ws.send(JSON.stringify({ v: 1, sessionId: sid, ...e })); } catch { /* ws may be closed */ }
        });
        return;
      }
      if (msg.type === 'attach' &&
          typeof msg.sessionId === 'string' &&
          typeof msg.mimeType === 'string' &&
          typeof msg.bytesBase64 === 'string' &&
          typeof msg.clientCorrelationId === 'string') {
        const sessionId = msg.sessionId as string;
        const mimeType = msg.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        const bytesBase64 = msg.bytesBase64 as string;
        const clientCorrelationId = msg.clientCorrelationId as string;
        this.sweepStagedAttachments();
        void (async () => {
          try {
            const { saveUserUpload } = await import('../user-uploads/store');
            const bytes = Buffer.from(bytesBase64, 'base64');
            const configDir = this.opts.configDir ?? '';
            const ref = await saveUserUpload(bytes, mimeType, sessionId, configDir);
            let m = this.stagedAttachments.get(sessionId);
            if (!m) { m = new Map(); this.stagedAttachments.set(sessionId, m); }
            m.set(ref.id, { ref, t: Date.now() });
            ws.send(JSON.stringify({ v: 1, type: 'attach_ok', clientCorrelationId, ref }));
          } catch (err) {
            ws.send(JSON.stringify({ v: 1, type: 'attach_err', clientCorrelationId: msg.clientCorrelationId, message: err instanceof Error ? err.message : String(err) }));
          }
        })();
        return;
      }
      if (msg.type === 'prompt' && typeof msg.text === 'string') {
        const attachments: ImageRef[] = [];
        const attachmentIds = Array.isArray(msg.attachmentIds) ? msg.attachmentIds as string[] : [];
        if (attachmentIds.length > 0) {
          const m = this.stagedAttachments.get(typeof msg.sessionId === 'string' ? msg.sessionId : '');
          if (m) {
            for (const id of attachmentIds) {
              const entry = m.get(id);
              if (entry) {
                attachments.push(entry.ref);
                m.delete(id);
              }
            }
          }
        }
        void this.opts.sendPrompt?.(msg.text, 'remote', attachments);
        return;
      }
      if (msg.type === 'interrupt') {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
        this.opts.interruptTurn?.(sid);
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ v: 1, type: 'pong' })); return; }
      if (msg.type === 'approval' && typeof msg.decisionId === 'string' && (msg.decision === 'approve' || msg.decision === 'deny')) {
        this.opts.resolveApproval?.(msg.decisionId, msg.decision);
        return;
      }
      if (msg.type === 'sudo' && typeof msg.promptId === 'string' && (typeof msg.password === 'string' || msg.password === null)) {
        this.opts.resolveSudo?.(msg.promptId, msg.password);
        return;
      }
      if (msg.type === 'switch_session' && typeof msg.sessionId === 'string') {
        const sid = msg.sessionId;
        void this.opts.switchSession?.(sid).then(() => {
          try { ws.send(JSON.stringify({ v: 1, type: 'session_switched', sessionId: sid })); } catch { /* ws may be closed */ }
        }).catch((err) => {
          logger.warn(`bridge: switch_session failed: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
      if (msg.type === 'new_session') {
        void this.opts.newSession?.().then((sid) => {
          try { ws.send(JSON.stringify({ v: 1, type: 'session_switched', sessionId: sid })); } catch { /* ws may be closed */ }
        }).catch((err) => {
          logger.warn(`bridge: new_session failed: ${err instanceof Error ? err.message : err}`);
        });
        return;
      }
    });

    ws.on('close', () => {
      const fn = unsub as (() => void) | null;
      if (fn) fn();
      // TODO: clear stagedAttachments for this connection's sessionId on disconnect.
      // The connection closure handler doesn't track a per-connection sessionId
      // (prompts can target any session). In-memory staging entries are cleaned
      // up as refs are consumed by prompts; the orphan sweep at next startup
      // removes any leftover on-disk files.
    });
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
    // Allow cross-origin requests from the native mobile app. Auth is
    // token-based and the server is Tailnet-only, so origin restriction
    // adds no security value here.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    try {
      // Dev-only: mint a pairing code via HTTP (gated behind devEndpoints).
      if (this.opts.devEndpoints && req.method === 'POST' && req.url === '/dev/mint') {
        const code = this.mintPairingCode();
        const addr = this.server!.address() as AddressInfo;
        const host = addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
        const url = `http://${host}:${addr.port}/?code=${code}`;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code, url, expiresAt: Date.now() + this.PAIR_TTL_MS }));
        return;
      }
      if (req.method === 'POST' && req.url === '/pair') return await this.handlePair(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/history')) return await this.handleHistory(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/sessions/')) return await this.handleSessionMessages(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/sessions')) return await this.handleSessions(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/screenshot/')) return await this.handleScreenshot(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/image')) return await this.handleImage(req, res);
      if (req.method === 'GET' && req.url?.startsWith('/user-upload/')) return await this.handleUserUpload(req, res);
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
    const { deviceId, token } = await this.opts.pairing.issue(body.deviceLabel ?? 'Mobile');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token, deviceId, wsUrl: `/ws`, hostLabel: hostname(), platform: process.platform }));
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

  private async handleImage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cache = this.opts.imageCache;
    if (!cache) { res.statusCode = 404; res.end('disabled'); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    // <img> tags can't send custom headers — the PWA appends the bearer as a
    // query param, matching how it would supply the WS token on first auth.
    const token = url.searchParams.get('token') ?? '';
    if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
    const encoded = url.searchParams.get('u');
    if (!encoded) { res.statusCode = 400; res.end('missing u'); return; }
    let target: string;
    try { target = Buffer.from(encoded, 'base64url').toString('utf8'); }
    catch { res.statusCode = 400; res.end('bad u'); return; }
    try {
      const cached = await cache.get(target);
      const buf = await fsp.readFile(cached.path);
      res.statusCode = 200;
      res.setHeader('content-type', cached.contentType);
      res.setHeader('cache-control', 'public, max-age=86400');
      res.end(buf);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      const reason = (err as Error).message ?? 'fetch failed';
      res.statusCode = status;
      res.end(reason);
    }
  }

  private async handleUserUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.opts.configDir) { res.statusCode = 404; res.end('disabled'); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    // <img> tags can't send custom headers — the PWA appends the bearer as a
    // query param, matching how /image does it.
    const token = url.searchParams.get('token') ?? '';
    if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
    // Path shape: /user-upload/<sessionId>/<file>
    const m = /^\/user-upload\/([^/?]+)\/([^/?]+)/.exec(url.pathname);
    if (!m) { res.statusCode = 400; res.end('bad path'); return; }
    const sessionId = m[1]!;
    const file = m[2]!;
    // Reuse the otto-image:// resolver — it expects that scheme so we synthesize one.
    const root = nodePath.join(this.opts.configDir, 'user-uploads');
    const r = resolveImageRequest(`otto-image://${sessionId}/${file}`, root);
    if (!r.ok) { res.statusCode = 404; res.end('not found'); return; }
    const ext = nodePath.extname(r.absPath).toLowerCase();
    const contentType =
      ext === '.png'  ? 'image/png'  :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif'  ? 'image/gif'  :
      'application/octet-stream';
    const buf = await fsp.readFile(r.absPath);
    res.statusCode = 200;
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'private, max-age=86400');
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

  private async handleSessions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
    const url = new URL(req.url!, 'http://x');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50') || 50, 1), 200);
    const metas = (await this.opts.listSessions?.(limit)) ?? [];
    const sessions = metas.map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      lastActive: m.lastActive,
      status: m.status,
    }));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessions }));
  }

  private async handleSessionMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
    const url = new URL(req.url!, 'http://x');
    // Expect: /sessions/<id>/messages
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'sessions' || parts[2] !== 'messages') {
      res.statusCode = 404; res.end('not found'); return;
    }
    const sessionId = decodeURIComponent(parts[1]!);
    const messages = (await this.opts.loadMessages?.(sessionId)) ?? [];
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ messages }));
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
