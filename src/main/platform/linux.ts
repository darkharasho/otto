import { spawn as nodeSpawn } from 'node:child_process';
import { desktopCapturer, nativeImage, screen } from 'electron';
import sharp from 'sharp';
import { checkBinary } from '../system/binary-check';
import type {
  CaptureOptions,
  CaptureResult,
  CursorPosition,
  DisplayServer,
  MonitorInfo,
  PlatformAdapter,
  PlatformInput,
  ShellChild,
} from './index';
import { isDevInstance } from '../instance';
import { createPortalInput, type InputHandle } from '../input/portal';
import { ottoConfigDir } from '../logger';

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

  private portalInput: InputHandle | null = null;

  private getPortalInput(): InputHandle {
    if (!this.portalInput) {
      this.portalInput = createPortalInput({ configDir: ottoConfigDir });
    }
    return this.portalInput;
  }

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

      // Capture each display via Electron's built-in desktopCapturer, then
      // stitch the per-display PNGs into one virtual-desktop image with sharp.
      // This replaces the previous spectacle(-bnfp) path which only captured
      // the focused monitor on KDE Wayland when -f/--fullscreen was used.
      //
      // TODO: overlay cursor position via screen.getCursorScreenPoint() —
      // see Otto autonomy docs about visual self-correction. The previous
      // spectacle -p flag included the cursor; desktopCapturer thumbnails do not.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 8192, height: 8192 }, // big enough for any single display
      });

      // Match each Electron display to a source by display_id.
      const tiles: Array<{ buf: Buffer; x: number; y: number; w: number; h: number }> = [];
      for (const display of screen.getAllDisplays()) {
        const source = sources.find(s => Number(s.display_id) === display.id);
        if (!source || source.thumbnail.isEmpty()) continue;
        // Thumbnail size is clamped to the display's actual native dimensions.
        const size = source.thumbnail.getSize();
        tiles.push({
          buf: source.thumbnail.toPNG(),
          x: display.bounds.x - bounds.x, // position relative to virtual-desktop origin
          y: display.bounds.y - bounds.y,
          w: size.width,
          h: size.height,
        });
      }

      if (tiles.length === 0) {
        throw new Error('screenshot failed: desktopCapturer returned no screen sources');
      }

      // Stitch all display tiles into one image at the virtual-desktop bounds.
      const fullW = bounds.w;
      const fullH = bounds.h;
      const stitched = await sharp({
        create: {
          width: fullW,
          height: fullH,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 },
        },
      })
        .composite(tiles.map(t => ({ input: t.buf, left: t.x, top: t.y })))
        .png()
        .toBuffer();

      if (!region) {
        return { bytes: stitched, width: fullW, height: fullH, monitors, origin: { x: bounds.x, y: bounds.y } };
      }

      // Region crop — translate virtual-desktop coords to image coords and honor primary scale.
      const r = region;
      const scale = monitors[0]?.scale || 1;
      const img = nativeImage.createFromBuffer(stitched);
      const cropped = img.crop({
        x: Math.round((r.x - bounds.x) * scale),
        y: Math.round((r.y - bounds.y) * scale),
        width: Math.round(r.w * scale),
        height: Math.round(r.h * scale),
      });
      const croppedBytes = cropped.toPNG();
      const { width: cw, height: ch } = cropped.getSize();
      return { bytes: croppedBytes, width: cw, height: ch, monitors, origin: { x: r.x, y: r.y } };
    },
  };

  input: PlatformInput = {
    cursorPosition: async (): Promise<CursorPosition> => {
      const point = screen.getCursorScreenPoint();
      return { x: point.x, y: point.y };
    },
    move: async (x, y): Promise<void> => {
      await this.getPortalInput().move(x, y);
    },
    scroll: async (dx, dy, x, y): Promise<void> => {
      await this.getPortalInput().scroll(dx, dy, x, y);
    },
    click: async (x, y, button): Promise<void> => {
      await this.getPortalInput().click(x, y, button);
    },
    doubleClick: async (x, y, button): Promise<void> => {
      await this.getPortalInput().doubleClick(x, y, button);
    },
    drag: async (x1, y1, x2, y2, button): Promise<void> => {
      await this.getPortalInput().drag(x1, y1, x2, y2, button);
    },
    type: async (text: string): Promise<void> => {
      await this.getPortalInput().type(text);
    },
    key: async (combo: string): Promise<void> => {
      await this.getPortalInput().key(combo);
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

}
