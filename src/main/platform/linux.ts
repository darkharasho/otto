import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage, screen } from 'electron';
import { checkBinary } from '../system/binary-check';
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
import { isDevInstance } from '../instance';

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

/** xdotool button numbers: 1=left, 2=middle, 3=right. */
const XBTN: Record<MouseButton, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

/** Translate Otto's xdotool-style combo to xdotool's lowercase-modifier form. */
function toXdotoolCombo(combo: string): string {
  return combo
    .split('+')
    .map((tok) => {
      const lower = tok.toLowerCase();
      if (lower === 'control' || lower === 'ctrl') return 'ctrl';
      if (lower === 'alt') return 'alt';
      if (lower === 'shift') return 'shift';
      if (lower === 'super' || lower === 'meta') return 'super';
      return tok;
    })
    .join('+');
}

function virtualDesktopBounds(monitors: MonitorInfo[]): { x: number; y: number; w: number; h: number } {
  if (monitors.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of monitors) {
    minX = Math.min(minX, m.x);
    minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + m.w);
    maxY = Math.max(maxY, m.y + m.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  detectDisplayServer(): DisplayServer {
    const s = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (s === 'wayland') return 'wayland';
    if (s === 'x11') return 'x11';
    return 'unknown';
  }

  defaultHotkey(): string {
    // Dev build uses a distinct chord so it doesn't fight the installed prod
    // build over the same global shortcut on X11.
    return isDevInstance() ? 'Ctrl+Shift+Alt+Space' : 'Super+Space';
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
      const monitors = this.allMonitors();
      const bounds = virtualDesktopBounds(monitors);
      if (opts.region && opts.window) {
        throw new Error('screenshot: pass either `region` or `window`, not both');
      }
      let region = opts.region;
      if (opts.window) {
        const geo = await this.resolveWindowGeometry(opts.window);
        // Clamp to virtual-desktop bounds so we don't ask Electron to crop
        // off-canvas (e.g., a window partially offscreen).
        const x = Math.max(geo.x, bounds.x);
        const y = Math.max(geo.y, bounds.y);
        const w = Math.max(1, Math.min(geo.x + geo.w, bounds.x + bounds.w) - x);
        const h = Math.max(1, Math.min(geo.y + geo.h, bounds.y + bounds.h) - y);
        region = { x, y, w, h };
      }
      if (region) {
        const r = region;
        const inside =
          r.x >= bounds.x &&
          r.y >= bounds.y &&
          r.x + r.w <= bounds.x + bounds.w &&
          r.y + r.h <= bounds.y + bounds.h;
        if (!inside) {
          throw new Error(
            `region {x:${r.x},y:${r.y},w:${r.w},h:${r.h}} exceeds virtual desktop bounds ` +
              `{x:${bounds.x},y:${bounds.y},w:${bounds.w},h:${bounds.h}}`
          );
        }
      }

      // Capture the full virtual desktop (all monitors). Coordinates everywhere
      // (region, click, move) are virtual-desktop absolute. Crop in-process
      // via nativeImage when the caller requested a region.
      const tmp = path.join(tmpdir(), `otto-screenshot-${randomUUID()}.png`);
      await this.runSpectacle(['-bnf', '-o', tmp], 5_000);

      try {
        const fullBytes = await fsp.readFile(tmp);
        if (!region) {
          const { width, height } = this.readPngDims(fullBytes);
          return { bytes: fullBytes, width, height, monitors, origin: { x: bounds.x, y: bounds.y } };
        }
        const r = region;
        // Region is given in virtual-desktop coords. Translate to image coords
        // by subtracting the virtual-desktop origin; honor primary scale.
        const scale = monitors[0]?.scale || 1;
        const img = nativeImage.createFromBuffer(fullBytes);
        const cropped = img.crop({
          x: Math.round((r.x - bounds.x) * scale),
          y: Math.round((r.y - bounds.y) * scale),
          width: Math.round(r.w * scale),
          height: Math.round(r.h * scale),
        });
        const croppedBytes = cropped.toPNG();
        const { width, height } = cropped.getSize();
        return { bytes: croppedBytes, width, height, monitors, origin: { x: r.x, y: r.y } };
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    },
  };

  input: PlatformInput = {
    cursorPosition: async (): Promise<CursorPosition> => {
      const point = screen.getCursorScreenPoint();
      return { x: point.x, y: point.y };
    },
    move: async (x: number, y: number): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['mousemove', String(x), String(y)]);
    },
    scroll: async (dx: number, dy: number, x?: number, y?: number): Promise<void> => {
      await this.ensureXdotool();
      if (x !== undefined && y !== undefined) {
        await this.runXdotool(['mousemove', String(x), String(y)]);
      }
      const vTicks = Math.abs(dy);
      const vBtn = dy < 0 ? '4' : '5'; // 4 = up, 5 = down
      for (let i = 0; i < vTicks; i += 1) {
        await this.runXdotool(['click', vBtn]);
      }
      const hTicks = Math.abs(dx);
      const hBtn = dx < 0 ? '6' : '7'; // 6 = left, 7 = right
      for (let i = 0; i < hTicks; i += 1) {
        await this.runXdotool(['click', hBtn]);
      }
    },
    click: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['mousemove', String(x), String(y)]);
      await this.runXdotool(['click', XBTN[button]]);
    },
    doubleClick: async (x: number, y: number, button: MouseButton): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['mousemove', String(x), String(y)]);
      await this.runXdotool(['click', '--repeat', '2', '--delay', '50', XBTN[button]]);
    },
    drag: async (x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['mousemove', String(x1), String(y1)]);
      await this.runXdotool(['mousedown', XBTN[button]]);
      await this.runXdotool(['mousemove', String(x2), String(y2)]);
      await this.runXdotool(['mouseup', XBTN[button]]);
    },
    type: async (text: string): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['type', '--delay', '20', '--', text]);
    },
    key: async (combo: string): Promise<void> => {
      await this.ensureXdotool();
      await this.runXdotool(['key', toXdotoolCombo(combo)]);
    },
  };

  private allMonitors(): MonitorInfo[] {
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      x: d.bounds.x,
      y: d.bounds.y,
      w: d.bounds.width,
      h: d.bounds.height,
      scale: d.scaleFactor,
    }));
  }

  private async resolveWindowGeometry(name: string): Promise<{ x: number; y: number; w: number; h: number }> {
    await this.ensureKdotool();
    const ids = (await this.runKdotool(['search', '--name', name])).split('\n').map((s) => s.trim()).filter(Boolean);
    const firstId = ids[0];
    if (!firstId) throw new Error(`no window matches name "${name}"`);
    const out = await this.runKdotool(['getwindowgeometry', firstId]);
    // kdotool prints lines like:
    //   Window <id>
    //     Position: X,Y (screen: N)
    //     Geometry: WxH
    const pos = /Position:\s*(-?\d+)\s*,\s*(-?\d+)/.exec(out);
    const geo = /Geometry:\s*(\d+)\s*x\s*(\d+)/.exec(out);
    const px = pos?.[1], py = pos?.[2], gw = geo?.[1], gh = geo?.[2];
    if (!px || !py || !gw || !gh) throw new Error(`could not parse kdotool getwindowgeometry output:\n${out}`);
    return { x: parseInt(px, 10), y: parseInt(py, 10), w: parseInt(gw, 10), h: parseInt(gh, 10) };
  }

  private async ensureKdotool(): Promise<void> {
    const r = await checkBinary({
      name: 'kdotool',
      purpose: 'KDE window query/geometry (xdotool-style API backed by KWin scripts)',
      hints: {
        fedora: 'cargo install kdotool  # or download from https://github.com/jinliu/kdotool',
        debian: 'cargo install kdotool  # or download from https://github.com/jinliu/kdotool',
        arch: 'paru -S kdotool',
        fallback: 'install kdotool from https://github.com/jinliu/kdotool',
      },
    });
    if (!r.ok) throw new Error(`${r.reason}\n\n${r.hint}`);
  }

  private runKdotool(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('kdotool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve(stdout);
        reject(new Error(`kdotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }

  private async ensureXdotool(): Promise<void> {
    const r = await checkBinary({
      name: 'xdotool',
      purpose: 'GUI input injection (works for XWayland windows on KDE Wayland)',
      hints: {
        fedora: 'sudo dnf install xdotool',
        debian: 'sudo apt install xdotool',
        arch: 'sudo pacman -S xdotool',
        fallback: 'install xdotool from your package manager',
      },
    });
    if (!r.ok) throw new Error(`${r.reason}\n\n${r.hint}`);
  }

  private runXdotool(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('xdotool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`xdotool failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }


  private async runSpectacle(args: string[], timeoutMs: number): Promise<void> {
    const check = await checkBinary({
      name: 'spectacle',
      purpose: 'screen capture',
      hints: {
        fedora: 'sudo dnf install kde-spectacle',
        debian: 'sudo apt install kde-spectacle',
        arch: 'sudo pacman -S spectacle',
        fallback: 'install KDE Spectacle from your package manager',
      },
    });
    if (!check.ok) throw new Error(`${check.reason}\n\n${check.hint}`);
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
