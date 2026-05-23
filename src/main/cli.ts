import net from 'node:net';
import path from 'node:path';
import { instanceSuffix, isDevInstance } from './instance';

/**
 * Compute the path to Otto's IPC socket. Dev and prod builds use different
 * socket basenames so the two can run side-by-side. Prefers
 * `$XDG_RUNTIME_DIR/otto[-dev].sock`; falls back to `/tmp/otto[-dev]-<uid>.sock`.
 */
export function socketPath(): string {
  const suffix = instanceSuffix();
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, `otto${suffix}.sock`);
  }
  const uid = process.getuid?.() ?? 0;
  return path.join('/tmp', `otto${suffix}-${uid}.sock`);
}

/**
 * Return true when this process was invoked as `otto toggle` — i.e. the
 * positional argument `toggle` is present in argv. We check positional args
 * only (skip argv[0] = node/electron binary, argv[1] = script path).
 *
 * `otto toggle --dev` (or `OTTO_DEV=1 otto toggle`) targets the dev instance's
 * socket — handy for binding a separate DE shortcut to the dev build.
 */
export function isToggleInvocation(): boolean {
  const positional = process.argv.slice(2);
  if (!positional.includes('toggle')) return false;
  // Side effect: surface `--dev` to instance.ts via env so socketPath() picks
  // the dev socket. We do this here because argv is the only signal a
  // standalone `otto toggle` invocation has — it's not a child of vite.
  if (positional.includes('--dev')) {
    process.env.OTTO_DEV = '1';
  }
  return true;
}

// Re-export so callers can branch on dev/prod without importing instance.ts
// alongside cli.ts when they already need socketPath.
export { isDevInstance };

/**
 * Connect to the running Otto's toggle socket, send a `toggle` command, log
 * the response to stdout, and resolve. Rejects if the connection cannot be
 * established (Otto not running) or the response is malformed.
 */
export async function sendToggle(): Promise<void> {
  const sock = socketPath();
  return new Promise<void>((resolve, reject) => {
    const client = net.createConnection({ path: sock }, () => {
      client.write(JSON.stringify({ cmd: 'toggle' }) + '\n');
    });
    let buf = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };
    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx >= 0) {
        const line = buf.slice(0, newlineIdx);
        // eslint-disable-next-line no-console
        console.log(line);
        finish();
      }
    });
    client.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        finish(new Error('Otto is not running. Start it first.'));
      } else {
        finish(err);
      }
    });
    client.on('close', () => {
      if (!settled) {
        if (buf.length > 0) {
          // eslint-disable-next-line no-console
          console.log(buf);
        }
        finish();
      }
    });
  });
}
