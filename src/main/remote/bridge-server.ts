import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';

export interface BridgeServerOpts {
  tailnetIp: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

export class BridgeServer {
  private server: http.Server | null = null;
  private readonly codes = new Map<string, PairingCode>();
  private readonly PAIR_TTL_MS = 120_000;

  constructor(private readonly opts: BridgeServerOpts) {}

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
    logger.info(`remote bridge listening on http://${this.opts.tailnetIp}:${port}`);
    return { port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
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
      res.statusCode = 404;
      res.end('not found');
    } catch (err) {
      logger.warn(`bridge: handler error: ${(err as Error).message}`);
      res.statusCode = 500;
      res.end('internal error');
    }
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
}
