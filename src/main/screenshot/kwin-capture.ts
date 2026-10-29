import dbus, { Variant, type MessageBus } from 'dbus-next';
import { spawn } from 'node:child_process';
import { promises as fsp, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { instanceDisplayName, instanceSuffix } from '../instance';

/**
 * Fast KDE Wayland capture through KWin's ScreenShot2 D-Bus interface.
 *
 * Spawning Spectacle costs ~1–1.7s per capture (it boots a whole Qt app);
 * asking KWin directly costs ~0.1s for the full workspace and less for an
 * area. Two prerequisites, either of which missing means "use Spectacle":
 *
 * 1. Authorization. ScreenShot2 is a restricted interface: KWin resolves the
 *    caller's /proc/<pid>/exe to a .desktop file and requires
 *    `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2` there. We
 *    write a hidden entry whose Exec is our own executable (rewritten per
 *    launch — an AppImage mounts at a new path every run) and refresh
 *    KSycoca so KWin sees it.
 * 2. File-descriptor passing. KWin streams the pixels into a pipe fd we hand
 *    it. dbus-next can only send fds over a usocket connection (a native
 *    optional dep built by scripts/build-usocket.mjs); without it the call
 *    fails with "Sending file descriptors is not supported".
 *
 * The image arrives as raw QImage bytes (ARGB32 in memory = BGRA on
 * little-endian), which is what Electron's createFromBitmap takes.
 */

const IFACE = 'org.kde.KWin.ScreenShot2';
const OBJECT_PATH = '/org/kde/KWin/ScreenShot2';
const READ_TIMEOUT_MS = 5_000;

// QImage::Format values whose in-memory layout is 32-bit BGRA on little-endian.
const BGRA_FORMATS = new Set([4 /* RGB32 */, 5 /* ARGB32 */, 6 /* ARGB32_Premultiplied */]);

export interface RawCapture {
  /** Tightly packed BGRA pixels (stride == width * 4). */
  bgra: Buffer;
  width: number;
  height: number;
}

export function kwinCaptureSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') return false;
  if ((env.XDG_SESSION_TYPE ?? '').toLowerCase() !== 'wayland') return false;
  if (env.OTTO_DISABLE_KWIN_CAPTURE === '1') return false;
  return /kde/i.test(env.XDG_CURRENT_DESKTOP ?? '');
}

export function desktopEntryContents(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${instanceDisplayName()} screen capture`,
    'Comment=Lets Otto capture the screen through KWin without spawning Spectacle',
    `Exec=${execPath}`,
    'NoDisplay=true',
    'Terminal=false',
    'X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2',
    '',
  ].join('\n');
}

function desktopEntryPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'applications', `otto-kwin-capture${instanceSuffix()}.desktop`);
}

/** Repack rows when KWin pads the stride; no copy when already tight. */
export function packRows(src: Buffer, width: number, height: number, stride: number): Buffer {
  const rowBytes = width * 4;
  if (stride === rowBytes) return src.subarray(0, rowBytes * height);
  const out = Buffer.allocUnsafe(rowBytes * height);
  for (let y = 0; y < height; y++) src.copy(out, y * rowBytes, y * stride, y * stride + rowBytes);
  return out;
}

function runQuiet(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

function unwrap(results: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(results)) {
    out[k] = val && typeof val === 'object' && 'value' in val ? (val as { value: unknown }).value : val;
  }
  return out;
}

async function readExactly(fh: fsp.FileHandle, n: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(n);
  let off = 0;
  while (off < n) {
    const { bytesRead } = await fh.read(buf, off, n - off, null);
    if (bytesRead === 0) throw new Error(`KWin closed the capture pipe after ${off}/${n} bytes`);
    off += bytesRead;
  }
  return buf;
}

type CaptureIface = {
  CaptureWorkspace(options: Record<string, Variant>, fd: number): Promise<Record<string, unknown>>;
  CaptureArea(
    x: number, y: number, w: number, h: number,
    options: Record<string, Variant>, fd: number
  ): Promise<Record<string, unknown>>;
};

class KwinCapturer {
  private bus: MessageBus | null = null;
  private iface: CaptureIface | null = null;
  private fifo: string | null = null;
  private authorizedOnce = false;
  // Serialize: one FIFO, one capture in flight.
  private chain: Promise<unknown> = Promise.resolve();

  async ensureAuthorized(force = false): Promise<void> {
    const target = desktopEntryPath();
    const want = desktopEntryContents(process.execPath);
    const have = await fsp.readFile(target, 'utf8').catch(() => '');
    if (have === want && !force) return;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, want, { mode: 0o644 });
    // KWin reads the desktop database through KSycoca; rebuild it so the new
    // entry is visible now rather than whenever kded notices the file.
    if (!(await runQuiet('kbuildsycoca6', [], 15_000))) await runQuiet('kbuildsycoca5', [], 15_000);
  }

  private async connect(): Promise<CaptureIface> {
    if (this.iface) return this.iface;
    // negotiateUnixFd is a real dbus-next option missing from its typings.
    const bus = dbus.sessionBus({ negotiateUnixFd: true } as Parameters<typeof dbus.sessionBus>[0]);
    try {
      const obj = await bus.getProxyObject('org.kde.KWin', OBJECT_PATH);
      this.iface = obj.getInterface(IFACE) as unknown as CaptureIface;
      this.bus = bus;
      return this.iface;
    } catch (err) {
      bus.disconnect();
      throw err;
    }
  }

  private async ensureFifo(): Promise<string> {
    if (this.fifo) return this.fifo;
    const p = path.join(os.tmpdir(), `otto-kwin-${process.pid}-${randomUUID()}.fifo`);
    if (!(await runQuiet('mkfifo', ['-m', '600', p], 5_000))) throw new Error('mkfifo failed');
    this.fifo = p;
    return p;
  }

  capture(area: { x: number; y: number; w: number; h: number } | null, includeCursor: boolean): Promise<RawCapture> {
    const run = this.chain.then(() => this.captureOnce(area, includeCursor));
    this.chain = run.catch(() => {});
    return run;
  }

  private async captureOnce(
    area: { x: number; y: number; w: number; h: number } | null,
    includeCursor: boolean
  ): Promise<RawCapture> {
    if (!this.authorizedOnce) {
      await this.ensureAuthorized();
    }
    try {
      const r = await this.captureRaw(area, includeCursor);
      this.authorizedOnce = true;
      return r;
    } catch (err) {
      // First-run race: KSycoca may not have picked the entry up yet.
      if (!this.authorizedOnce && /not authorized/i.test(String((err as { text?: string }).text ?? err))) {
        await this.ensureAuthorized(true);
        const r = await this.captureRaw(area, includeCursor);
        this.authorizedOnce = true;
        return r;
      }
      throw err;
    }
  }

  private async captureRaw(
    area: { x: number; y: number; w: number; h: number } | null,
    includeCursor: boolean
  ): Promise<RawCapture> {
    const iface = await this.connect();
    const fifo = await this.ensureFifo();
    // O_RDWR on the write side keeps the open from blocking for a reader;
    // the reader then opens immediately because a writer exists.
    const wfd = await fsp.open(fifo, fsc.O_RDWR);
    let rfh: fsp.FileHandle | null = null;
    try {
      rfh = await fsp.open(fifo, fsc.O_RDONLY);
      const options = {
        'include-cursor': new Variant('b', includeCursor),
        'native-resolution': new Variant('b', true),
      };
      const results = unwrap(
        area
          ? await iface.CaptureArea(area.x, area.y, area.w, area.h, options, wfd.fd)
          : await iface.CaptureWorkspace(options, wfd.fd)
      );
      // KWin dup'd the fd; drop ours so a KWin-side failure surfaces as EOF.
      await wfd.close();
      const width = Number(results.width);
      const height = Number(results.height);
      const stride = Number(results.stride);
      const format = Number(results.format);
      if (results.type !== 'raw' || !BGRA_FORMATS.has(format) || !width || !height || stride < width * 4) {
        throw new Error(`unsupported KWin capture result ${JSON.stringify(results)}`);
      }
      const fh = rfh;
      const raw = await Promise.race([
        readExactly(fh, stride * height),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('KWin capture read timed out')), READ_TIMEOUT_MS).unref()
        ),
      ]);
      return { bgra: packRows(raw, width, height, stride), width, height };
    } finally {
      await wfd.close().catch(() => {});
      // Not awaited: after a read timeout the pending read still holds the
      // handle, and close() would wait on it.
      void rfh?.close().catch(() => {});
    }
  }

  dispose(): void {
    this.bus?.disconnect();
    this.bus = null;
    this.iface = null;
    if (this.fifo) void fsp.unlink(this.fifo).catch(() => {});
    this.fifo = null;
  }
}

let capturer: KwinCapturer | null = null;
let disabledReason: string | null = null;

/**
 * Capture through KWin, or return null when the fast path is unavailable
 * (unsupported session, not authorized, no fd passing). The first failure
 * disables the path for the rest of the run so every later capture goes
 * straight to the Spectacle fallback instead of paying for a doomed attempt.
 */
export async function kwinCapture(
  area: { x: number; y: number; w: number; h: number } | null,
  includeCursor = true
): Promise<RawCapture | null> {
  if (disabledReason || !kwinCaptureSupported()) return null;
  capturer ??= new KwinCapturer();
  try {
    return await capturer.capture(area, includeCursor);
  } catch (err) {
    disabledReason = String((err as { text?: string }).text ?? (err instanceof Error ? err.message : err));
    logger.warn(`KWin fast capture unavailable, falling back to Spectacle: ${disabledReason}`);
    capturer.dispose();
    capturer = null;
    return null;
  }
}

// Test seam.
export function __resetKwinCaptureForTest(): void {
  capturer?.dispose();
  capturer = null;
  disabledReason = null;
}
