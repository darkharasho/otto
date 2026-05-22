import net from 'node:net';
import path from 'node:path';

/**
 * Compute the path to Otto's IPC socket. Prefers `$XDG_RUNTIME_DIR/otto.sock`
 * when XDG_RUNTIME_DIR is set; otherwise falls back to `/tmp/otto-<uid>.sock`.
 */
export function socketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'otto.sock');
  }
  const uid = process.getuid?.() ?? 0;
  return path.join('/tmp', `otto-${uid}.sock`);
}

/**
 * Return true when this process was invoked as `otto toggle` — i.e. the
 * positional argument `toggle` is present in argv. We check positional args
 * only (skip argv[0] = node/electron binary, argv[1] = script path).
 */
export function isToggleInvocation(): boolean {
  const positional = process.argv.slice(2);
  return positional.includes('toggle');
}

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
