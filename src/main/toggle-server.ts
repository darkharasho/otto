import net from 'node:net';
import fs from 'node:fs';
import { logger } from './logger';
import { socketPath } from './cli';

/**
 * Listens on a Unix domain socket and invokes `onToggle()` when a
 * `{"cmd":"toggle"}` newline-delimited JSON message arrives. This is the
 * primary trigger mechanism on Wayland, where global hotkey registration via
 * `globalShortcut` is not supported and `xdg-desktop-portal` is unreliable.
 * Users bind their DE keyboard shortcut to `otto toggle`, which sends a
 * command over this socket.
 */
export class ToggleServer {
  private server: net.Server | null = null;
  private boundPath: string | null = null;

  constructor(private readonly onToggle: () => void) {}

  async start(): Promise<void> {
    const sock = socketPath();
    // Clean up a stale socket file from a previous run (or crashed instance).
    try {
      fs.unlinkSync(sock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`toggle server: could not unlink stale socket at ${sock}: ${(err as Error).message}`);
      }
    }

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx: number;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line) as { cmd?: string };
              if (msg.cmd === 'toggle') {
                try {
                  this.onToggle();
                } catch (err) {
                  logger.warn(`toggle callback threw: ${err instanceof Error ? err.message : err}`);
                }
                conn.write(JSON.stringify({ ok: true }) + '\n');
              } else {
                conn.write(JSON.stringify({ ok: false, error: `unknown cmd: ${msg.cmd ?? '(none)'}` }) + '\n');
              }
            } catch (err) {
              conn.write(JSON.stringify({ ok: false, error: `bad JSON: ${(err as Error).message}` }) + '\n');
            }
          }
        });
        conn.on('error', (err) => {
          logger.warn(`toggle server: connection error: ${err.message}`);
        });
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(sock, () => {
        // Restrict access to the owning user.
        try {
          fs.chmodSync(sock, 0o600);
        } catch (err) {
          logger.warn(`toggle server: could not chmod socket: ${(err as Error).message}`);
        }
        this.server = server;
        this.boundPath = sock;
        logger.info(`toggle server listening on ${sock}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    const sock = this.boundPath;
    this.server = null;
    this.boundPath = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (sock) {
      try {
        fs.unlinkSync(sock);
      } catch {
        // ignore — may already be gone
      }
    }
  }
}
