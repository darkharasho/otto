import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { screen } from 'electron';
import type {
  CaptureOptions,
  CaptureResult,
  DisplayServer,
  MonitorInfo,
  PlatformAdapter,
  ShellChild,
} from './index';

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  detectDisplayServer(): DisplayServer {
    const s = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (s === 'wayland') return 'wayland';
    if (s === 'x11') return 'x11';
    return 'unknown';
  }

  defaultHotkey(): string {
    return 'Super+Space';
  }

  shell = {
    spawnShell: (command: string, cwd: string): ShellChild => {
      const child = nodeSpawn('sh', ['-c', command], {
        cwd,
        env: this.shell.composeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
        }
      );
      return {
        pid: child.pid ?? -1,
        stdout: child.stdout!,
        stderr: child.stderr!,
        kill: (signal: NodeJS.Signals) => child.kill(signal),
        exited,
      };
    },
    composeEnv: (): NodeJS.ProcessEnv => ({ ...process.env }),
  };

  screenshot = {
    capture: async (opts: CaptureOptions): Promise<CaptureResult> => {
      const monitor = this.activeMonitor();
      if (opts.region) {
        const r = opts.region;
        if (r.x < 0 || r.y < 0 || r.x + r.w > monitor.w || r.y + r.h > monitor.h) {
          throw new Error(
            `region {x:${r.x},y:${r.y},w:${r.w},h:${r.h}} exceeds monitor bounds {0,0,${monitor.w},${monitor.h}}`
          );
        }
      }

      const tmp = path.join(tmpdir(), `otto-screenshot-${randomUUID()}.png`);
      const args = opts.region
        ? [
            '-bn',
            '--region',
            `${monitor.x + opts.region.x},${monitor.y + opts.region.y},${opts.region.w},${opts.region.h}`,
            '-o',
            tmp,
          ]
        : ['-bnf', '-o', tmp];

      await this.runSpectacle(args, 5_000);

      try {
        const bytes = await fsp.readFile(tmp);
        const { width, height } = this.readPngDims(bytes);
        return { bytes, width, height, monitor };
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    },
  };

  private activeMonitor(): MonitorInfo {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    return {
      id: String(display.id),
      x: display.bounds.x,
      y: display.bounds.y,
      w: display.bounds.width,
      h: display.bounds.height,
      scale: display.scaleFactor,
    };
  }

  private runSpectacle(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('spectacle', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      }, timeoutMs);
      child.once('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('spectacle not found — install kde-spectacle'));
        } else {
          reject(err);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('screenshot timed out'));
        if (code !== 0) return reject(new Error(`screenshot failed: ${stderr.trim() || `exit ${code}`}`));
        resolve();
      });
    });
  }

  private readPngDims(bytes: Buffer): { width: number; height: number } {
    if (bytes.length < 24 || bytes.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
      throw new Error('captured file is not a PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return { width, height };
  }
}
