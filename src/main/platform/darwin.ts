import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage, screen } from 'electron';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Run a shell command and return stdout. Rejects on non-zero exit. */
function run(cmd: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`${cmd} failed (exit ${code}): ${stderr.trim()}`));
      resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// CGEvent-based mouse input via JXA (JavaScript for Automation)
//
// macOS's `osascript -l JavaScript` can bridge to Objective-C/CoreGraphics,
// giving us CGEvent mouse simulation with zero external dependencies.
// ---------------------------------------------------------------------------

const BUTTON_MAP: Record<MouseButton, { cg: number; downType: number; upType: number; dragType: number }> = {
  left:   { cg: 0, downType: 1,  upType: 2,  dragType: 6 },  // kCGMouseButtonLeft,  kCGEventLeftMouseDown/Up/Dragged
  right:  { cg: 1, downType: 3,  upType: 4,  dragType: 7 },  // kCGMouseButtonRight, kCGEventRightMouseDown/Up/Dragged
  middle: { cg: 2, downType: 25, upType: 26, dragType: 27 },  // kCGMouseButtonCenter, kCGEventOtherMouseDown/Up/Dragged
};

function jxaMouse(script: string): Promise<void> {
  return run('osascript', ['-l', 'JavaScript', '-e', script]).then(() => {});
}

function jxaMove(x: number, y: number): Promise<void> {
  // kCGEventMouseMoved = 5
  return jxaMouse(`
    ObjC.import('CoreGraphics');
    var pt = $.CGPointMake(${x}, ${y});
    var ev = $.CGEventCreateMouseEvent(null, 5, pt, 0);
    $.CGEventPost($.kCGHIDEventTap, ev);
  `);
}

function jxaClick(x: number, y: number, button: MouseButton): Promise<void> {
  const b = BUTTON_MAP[button];
  return jxaMouse(`
    ObjC.import('CoreGraphics');
    var pt = $.CGPointMake(${x}, ${y});
    var down = $.CGEventCreateMouseEvent(null, ${b.downType}, pt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, down);
    var up = $.CGEventCreateMouseEvent(null, ${b.upType}, pt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, up);
  `);
}

function jxaDoubleClick(x: number, y: number, button: MouseButton): Promise<void> {
  const b = BUTTON_MAP[button];
  // Set click count to 2 on the second down event via CGEventSetIntegerValueField.
  // kCGMouseEventClickState = 1
  return jxaMouse(`
    ObjC.import('CoreGraphics');
    var pt = $.CGPointMake(${x}, ${y});
    var d1 = $.CGEventCreateMouseEvent(null, ${b.downType}, pt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, d1);
    var u1 = $.CGEventCreateMouseEvent(null, ${b.upType}, pt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, u1);
    var d2 = $.CGEventCreateMouseEvent(null, ${b.downType}, pt, ${b.cg});
    $.CGEventSetIntegerValueField(d2, 1, 2);
    $.CGEventPost($.kCGHIDEventTap, d2);
    var u2 = $.CGEventCreateMouseEvent(null, ${b.upType}, pt, ${b.cg});
    $.CGEventSetIntegerValueField(u2, 1, 2);
    $.CGEventPost($.kCGHIDEventTap, u2);
  `);
}

function jxaDrag(x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void> {
  const b = BUTTON_MAP[button];
  // Move to start, press, drag in steps, release.
  const steps = 10;
  let dragStatements = '';
  for (let i = 1; i <= steps; i++) {
    const fx = x1 + ((x2 - x1) * i) / steps;
    const fy = y1 + ((y2 - y1) * i) / steps;
    dragStatements += `
    var dp${i} = $.CGEventCreateMouseEvent(null, ${b.dragType}, $.CGPointMake(${fx}, ${fy}), ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, dp${i});`;
  }
  return jxaMouse(`
    ObjC.import('CoreGraphics');
    var startPt = $.CGPointMake(${x1}, ${y1});
    var endPt = $.CGPointMake(${x2}, ${y2});
    var move = $.CGEventCreateMouseEvent(null, 5, startPt, 0);
    $.CGEventPost($.kCGHIDEventTap, move);
    delay(0.05);
    var down = $.CGEventCreateMouseEvent(null, ${b.downType}, startPt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, down);
    delay(0.05);
    ${dragStatements}
    delay(0.05);
    var up = $.CGEventCreateMouseEvent(null, ${b.upType}, endPt, ${b.cg});
    $.CGEventPost($.kCGHIDEventTap, up);
  `);
}

function jxaScroll(dx: number, dy: number, x?: number, y?: number): Promise<void> {
  // If position is given, move there first. Then post a scroll event.
  // kCGEventScrollWheel = 22, kCGScrollEventUnitPixel = 0
  const moveSnippet = (x != null && y != null)
    ? `var mv = $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(${x}, ${y}), 0);
       $.CGEventPost($.kCGHIDEventTap, mv);
       delay(0.02);`
    : '';
  return jxaMouse(`
    ObjC.import('CoreGraphics');
    ${moveSnippet}
    var sc = $.CGEventCreateScrollWheelEvent(null, 0, 2, ${-dy}, ${-dx});
    $.CGEventPost($.kCGHIDEventTap, sc);
  `);
}

// ---------------------------------------------------------------------------
// Keyboard input via AppleScript System Events
// ---------------------------------------------------------------------------

/** Type literal text via System Events keystroke. */
function asType(text: string): Promise<void> {
  // Escape backslashes and double-quotes for AppleScript string literal.
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return run('osascript', [
    '-e', `tell application "System Events" to keystroke "${escaped}"`,
  ]).then(() => {});
}

// Map common key names to macOS key codes (as used by System Events `key code`).
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** Press a key combo like "cmd+shift+s" or "return". */
function asKey(combo: string): Promise<void> {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  const modifiers: string[] = [];
  let keyPart = '';

  for (const p of parts) {
    if (['cmd', 'command', 'meta', 'super'].includes(p)) modifiers.push('command down');
    else if (['ctrl', 'control'].includes(p)) modifiers.push('control down');
    else if (['alt', 'option', 'opt'].includes(p)) modifiers.push('option down');
    else if (['shift'].includes(p)) modifiers.push('shift down');
    else keyPart = p;
  }

  const modUsing = modifiers.length > 0
    ? ` using {${modifiers.join(', ')}}`
    : '';

  const keyCode = KEY_CODES[keyPart];
  if (keyCode != null) {
    return run('osascript', [
      '-e', `tell application "System Events" to key code ${keyCode}${modUsing}`,
    ]).then(() => {});
  }

  // Single character — use keystroke
  if (keyPart.length === 1) {
    const escaped = keyPart.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run('osascript', [
      '-e', `tell application "System Events" to keystroke "${escaped}"${modUsing}`,
    ]).then(() => {});
  }

  throw new Error(`unknown key: "${keyPart}" in combo "${combo}"`);
}

// ---------------------------------------------------------------------------
// Window geometry via AppleScript
// ---------------------------------------------------------------------------

async function resolveWindowGeometry(name: string): Promise<{ x: number; y: number; w: number; h: number }> {
  // Search all running apps for a window whose name contains the pattern.
  const script = `
    tell application "System Events"
      set matchedProcs to every process whose visible is true
      repeat with proc in matchedProcs
        try
          set wins to every window of proc
          repeat with w in wins
            if name of w contains "${name.replace(/"/g, '\\"')}" then
              set pos to position of w
              set sz to size of w
              return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
            end if
          end repeat
        end try
      end repeat
    end tell
    error "no window matches name \\"${name.replace(/"/g, '\\"')}\\""
  `;
  const out = (await run('osascript', ['-e', script], 10_000)).trim();
  const [xs, ys, ws, hs] = out.split(',');
  if (!xs || !ys || !ws || !hs) throw new Error(`could not parse window geometry: ${out}`);
  return { x: parseInt(xs, 10), y: parseInt(ys, 10), w: parseInt(ws, 10), h: parseInt(hs, 10) };
}

// ---------------------------------------------------------------------------
// DarwinAdapter
// ---------------------------------------------------------------------------

export class DarwinAdapter implements PlatformAdapter {
  readonly name = 'darwin';

  detectDisplayServer(): DisplayServer {
    // macOS uses Quartz/Core Graphics — no X11/Wayland concept.
    return 'unknown';
  }

  defaultHotkey(): string {
    // Dev build uses a distinct chord so it doesn't fight the installed prod build.
    return isDevInstance() ? 'Ctrl+Shift+Cmd+Space' : 'Ctrl+Shift+Space';
  }

  shell = {
    spawnShell: (command: string, cwd: string): ShellChild => {
      const child = nodeSpawn('/bin/zsh', ['-c', command], {
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
        const geo = await resolveWindowGeometry(opts.window);
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

      const tmp = path.join(tmpdir(), `otto-screenshot-${randomUUID()}.png`);
      if (region) {
        // screencapture -R x,y,w,h captures a specific rectangle.
        // -x suppresses the camera shutter sound.
        const r = region;
        const scale = monitors[0]?.scale || 1;
        await run('screencapture', [
          '-x', '-R', `${r.x},${r.y},${r.w},${r.h}`, tmp,
        ]);
        try {
          const bytes = await fsp.readFile(tmp);
          // screencapture on Retina captures at device pixels, so actual image
          // dimensions may be scaled. Read from the PNG header.
          const { width, height } = this.readPngDims(bytes);
          return { bytes, width, height, monitors, origin: { x: r.x, y: r.y } };
        } finally {
          await fsp.unlink(tmp).catch(() => {});
        }
      }

      // Full screen capture (all displays).
      // -x = silent, no shutter sound
      await run('screencapture', ['-x', tmp]);
      try {
        const bytes = await fsp.readFile(tmp);
        const { width, height } = this.readPngDims(bytes);
        return { bytes, width, height, monitors, origin: { x: bounds.x, y: bounds.y } };
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
    move: async (x, y) => jxaMove(x, y),
    scroll: async (dx, dy, x?, y?) => jxaScroll(dx, dy, x, y),
    click: async (x, y, button) => jxaClick(x, y, button),
    doubleClick: async (x, y, button) => jxaDoubleClick(x, y, button),
    drag: async (x1, y1, x2, y2, button) => jxaDrag(x1, y1, x2, y2, button),
    type: async (text: string) => asType(text),
    key: async (combo: string) => asKey(combo),
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

  private readPngDims(bytes: Buffer): { width: number; height: number } {
    if (bytes.length < 24 || bytes.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
      throw new Error('captured file is not a PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return { width, height };
  }
}
