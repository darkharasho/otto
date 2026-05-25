import http from 'node:http';
import { AddressInfo } from 'node:net';
import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';

export interface BridgeServerOpts {
  tailnetIp: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
}

export class BridgeServer {
  private server: http.Server | null = null;

  constructor(private readonly opts: BridgeServerOpts) {}

  async start(): Promise<{ port: number }> {
    if (!this.opts.tailnetIp) {
      throw new Error('tailnet IP not available; refusing to bind to 0.0.0.0 or 127.0.0.1');
    }
    const server = http.createServer((req, res) => this.handle(req, res));
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

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.statusCode = 404;
    res.end('not found');
  }
}
