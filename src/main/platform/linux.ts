import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage, screen } from 'electron';
import { translateKeyCombo } from '../input/keymap';
import { checkYdotoolReady } from '../input/setup-check';
import type {
  CaptureOptions,
  CaptureResult,
  CursorPosition,
  DisplayServer,
  MonitorInfo,
  MouseButton,
  PlatformAdapter,
  PlatformInput,
  ShellChild,
} from './index';

const BUTTON_CODE: Record<MouseButton, string> = {
  left: '0xC0',
  right: '0xC1',
  middle: '0xC2',
};

const BUTTON_LOW: Record<MouseButton, string> = {
  left: '0x40',
  right: '0x41',
  middle: '0x42',
};

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

      // Always capture the full active monitor; spectacle's --region flag opens
      // an interactive picker we don't want. Crop in-process via nativeImage
      // when the caller requested a region.
      const tmp = path.join(tmpdir(), `otto-screenshot-${randomUUID()}.png`);
      await this.runSpectacle(['-bnm', '-o', tmp], 5_000);

      try {
        const fullBytes = await fsp.readFile(tmp);
        if (!opts.region) {
          const { width, height } = this.readPngDims(fullBytes);
          return { bytes: fullBytes, width, height, monitor };
        }
        const r = opts.region;
        const scale = monitor.scale || 1;
        const img = nativeImage.createFromBuffer(fullBytes);
        const cropped = img.crop({
          x: Math.round(r.x * scale),
          y: Math.round(r.y * scale),
          width: Math.round(r.w * scale),
          height: Math.round(r.h * scale),
        });
        const croppedBytes = cropped.toPNG();
        const { width, height } = cropped.getSize();
        return { bytes: croppedBytes, width, height, monitor };
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    },
  };

  input: PlatformInput = {
    cursorPosition: async (): Promise<CursorPosition> => {
      const point = screen.getCursorScreenPoint();
      const monitor = this.activeMonitor();
      return { x: point.x - monitor.x, y: point.y - monitor.y };
    },
    move: async (x: number, y: number): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
    },
    scroll: async (dx: number, dy: number, x?: number, y?: number): Promise<void> => {
      await this.ensureInputReady();
      if (x !== undefined && y !== undefined) {
        const { absX, absY } = this.absolute(x, y);
        await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      }
      if (dy !== 0) {
        await this.runYdotool(['mousemove', '--wheel', '0', String(dy)]);
      }
      if (dx !== 0) {
        await this.runYdotool(['mousemove', '--hwheel', String(dx), '0']);
      }
    },
    click: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      await this.runYdotool(['click', BUTTON_CODE[button]]);
    },
    doubleClick: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const { absX, absY } = this.absolute(x, y);
      await this.runYdotool(['mousemove', '--absolute', String(absX), String(absY)]);
      await this.runYdotool(['click', BUTTON_CODE[button]]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await this.runYdotool(['click', BUTTON_CODE[button]]);
    },
    drag: async (x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void> => {
      await this.ensureInputReady();
      const a = this.absolute(x1, y1);
      const b = this.absolute(x2, y2);
      await this.runYdotool(['mousemove', '--absolute', String(a.absX), String(a.absY)]);
      await this.runYdotool(['mousedown', BUTTON_LOW[button]]);
      await this.runYdotool(['mousemove', '--absolute', String(b.absX), String(b.absY)]);
      await this.runYdotool(['mouseup', BUTTON_LOW[button]]);
    },
    type: async (text: string): Promise<void> => {
      await this.ensureInputReady();
      await this.runYdotoolWithStdin(['type', '--'], text);
    },
    key: async (combo: string): Promise<void> => {
      await this.ensureInputReady();
      const events = translateKeyCombo(combo);
      const args = ['key', ...events.map((e) => `${e.code}:${e.state}`)];
      await this.runYdotool(args);
    },
  };

  private absolute(x: number, y: number): { absX: number; absY: number } {
    const monitor = this.activeMonitor();
    return { absX: monitor.x + x, absY: monitor.y + y };
  }

  private async ensureInputReady(): Promise<void> {
    const r = await checkYdotoolReady();
    if (!r.ok) {
      throw new Error(`${r.reason}\n\n${r.hint}`);
    }
  }

  private runYdotool(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('ydotool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve();
        if (/permission denied|EACCES/i.test(stderr)) {
          reject(new Error(
            'Permission denied — add your user to the input group:\n' +
            'sudo usermod -aG input $USER\n' +
            '(then log out and back in)'
          ));
          return;
        }
        reject(new Error(`ydotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }

  private runYdotoolWithStdin(args: string[], stdinText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('ydotool', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve();
        if (/permission denied|EACCES/i.test(stderr)) {
          reject(new Error(
            'Permission denied — add your user to the input group:\n' +
            'sudo usermod -aG input $USER\n' +
            '(then log out and back in)'
          ));
          return;
        }
        reject(new Error(`ydotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
      child.stdin.end(stdinText);
    });
  }

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
