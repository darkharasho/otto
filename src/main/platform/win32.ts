import { promises as fsp } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { screen } from 'electron';
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
import { getWin32PsHost, type Win32PsHost } from './win32-ps-host';

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

/** Escape PowerShell single-quoted literal (double `'` to include one). */
function pshSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Mouse — uses SetCursorPos + mouse_event via the persistent PS host
// ---------------------------------------------------------------------------
//
// mouse_event flag constants (winuser.h):
//   MOUSEEVENTF_LEFTDOWN   0x0002
//   MOUSEEVENTF_LEFTUP     0x0004
//   MOUSEEVENTF_RIGHTDOWN  0x0008
//   MOUSEEVENTF_RIGHTUP    0x0010
//   MOUSEEVENTF_MIDDLEDOWN 0x0020
//   MOUSEEVENTF_MIDDLEUP   0x0040
//   MOUSEEVENTF_WHEEL      0x0800
//   MOUSEEVENTF_HWHEEL     0x1000

const MOUSE_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left:   { down: 0x0002, up: 0x0004 },
  right:  { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

function moveScript(x: number, y: number): string {
  return `[Otto.Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`;
}

function clickScript(x: number, y: number, button: MouseButton): string {
  const f = MOUSE_FLAGS[button];
  return `
[Otto.Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 20
[Otto.Native]::mouse_event(${f.down}, 0, 0, 0, [System.IntPtr]::Zero)
[Otto.Native]::mouse_event(${f.up}, 0, 0, 0, [System.IntPtr]::Zero)
`;
}

function doubleClickScript(x: number, y: number, button: MouseButton): string {
  const f = MOUSE_FLAGS[button];
  return `
[Otto.Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 20
[Otto.Native]::mouse_event(${f.down}, 0, 0, 0, [System.IntPtr]::Zero)
[Otto.Native]::mouse_event(${f.up}, 0, 0, 0, [System.IntPtr]::Zero)
Start-Sleep -Milliseconds 40
[Otto.Native]::mouse_event(${f.down}, 0, 0, 0, [System.IntPtr]::Zero)
[Otto.Native]::mouse_event(${f.up}, 0, 0, 0, [System.IntPtr]::Zero)
`;
}

function dragScript(x1: number, y1: number, x2: number, y2: number, button: MouseButton): string {
  const f = MOUSE_FLAGS[button];
  const steps = 10;
  const parts: string[] = [];
  for (let i = 1; i <= steps; i++) {
    const fx = Math.round(x1 + ((x2 - x1) * i) / steps);
    const fy = Math.round(y1 + ((y2 - y1) * i) / steps);
    parts.push(`[Otto.Native]::SetCursorPos(${fx}, ${fy}) | Out-Null`);
    parts.push('Start-Sleep -Milliseconds 10');
  }
  return `
[Otto.Native]::SetCursorPos(${Math.round(x1)}, ${Math.round(y1)}) | Out-Null
Start-Sleep -Milliseconds 30
[Otto.Native]::mouse_event(${f.down}, 0, 0, 0, [System.IntPtr]::Zero)
${parts.join('\n')}
[Otto.Native]::mouse_event(${f.up}, 0, 0, 0, [System.IntPtr]::Zero)
`;
}

function scrollScript(dx: number, dy: number, x?: number, y?: number): string | null {
  // Windows scroll unit: WHEEL_DELTA = 120 per notch. Convert logical pixels
  // with ~40px = 1 notch. Sign is negated to match the darwin contract:
  // positive dy scrolls *content* downward.
  const WHEEL_DELTA = 120;
  const PIXELS_PER_NOTCH = 40;
  const vDelta = -Math.round((dy / PIXELS_PER_NOTCH) * WHEEL_DELTA);
  const hDelta = -Math.round((dx / PIXELS_PER_NOTCH) * WHEEL_DELTA);
  const uint32 = (n: number): number => (n < 0 ? 0x100000000 + n : n);
  const move = (x != null && y != null)
    ? `[Otto.Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
       Start-Sleep -Milliseconds 20`
    : '';
  const events: string[] = [];
  if (vDelta !== 0) events.push(`[Otto.Native]::mouse_event(0x0800, 0, 0, ${uint32(vDelta)}, [System.IntPtr]::Zero)`);
  if (hDelta !== 0) events.push(`[Otto.Native]::mouse_event(0x1000, 0, 0, ${uint32(hDelta)}, [System.IntPtr]::Zero)`);
  if (!move && events.length === 0) return null;
  return `${move}\n${events.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Keyboard — SendInput with KEYEVENTF_UNICODE for full Unicode text input,
// and VkKeyScan-based virtual-key events for named-key combos.
// ---------------------------------------------------------------------------
//
// KEYBDINPUT / SendInput constants:
//   INPUT_KEYBOARD          1
//   KEYEVENTF_EXTENDEDKEY   0x0001  (arrow / navigation keys)
//   KEYEVENTF_KEYUP         0x0002
//   KEYEVENTF_UNICODE       0x0004
//   KEYEVENTF_SCANCODE      0x0008

const VK: Record<string, number> = {
  return: 0x0D, enter: 0x0D, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E, del: 0x2E,
  escape: 0x1B, esc: 0x1B,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
};

// Windows treats arrow / navigation keys as "extended" — SendInput needs the
// EXTENDEDKEY flag set for them to reach apps that discriminate (e.g. games).
const EXTENDED_VKS = new Set([
  0x21, 0x22, 0x23, 0x24, // pageup, pagedown, end, home
  0x25, 0x26, 0x27, 0x28, // left, up, right, down
  0x2D, 0x2E,             // insert, delete
]);

/**
 * Type arbitrary Unicode text via SendInput + KEYEVENTF_UNICODE. Each code
 * unit becomes a pair of keydown/keyup INPUT records with wVk=0, wScan=cu.
 * Handles UTF-16 surrogate pairs by emitting them as consecutive code units
 * (Windows delivers them as WM_CHAR pairs, which apps assemble back into a
 * supplementary-plane character).
 */
function typeScript(text: string): string {
  // Encode the string as an array of UTF-16 code unit ints. PowerShell can
  // build the INPUT[] and pass it to SendInput in one call, which is far
  // faster than one call per character.
  const units: number[] = [];
  for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i));
  // Chunk to avoid absurd script sizes for very long strings. SendInput
  // itself has no small limit, but PS command-line assembly does.
  const CHUNK = 512;
  const chunks: number[][] = [];
  for (let i = 0; i < units.length; i += CHUNK) chunks.push(units.slice(i, i + CHUNK));
  const parts: string[] = [];
  for (const c of chunks) {
    const literal = c.length > 0 ? c.join(',') : '';
    parts.push(`
$codes = @(${literal})
$inputs = New-Object 'Otto.INPUT[]' ($codes.Length * 2)
for ($i = 0; $i -lt $codes.Length; $i++) {
  $inputs[$i * 2].type = 1
  $inputs[$i * 2].U.ki.wVk = 0
  $inputs[$i * 2].U.ki.wScan = [uint16]$codes[$i]
  $inputs[$i * 2].U.ki.dwFlags = 0x0004  # KEYEVENTF_UNICODE (down)
  $inputs[$i * 2 + 1].type = 1
  $inputs[$i * 2 + 1].U.ki.wVk = 0
  $inputs[$i * 2 + 1].U.ki.wScan = [uint16]$codes[$i]
  $inputs[$i * 2 + 1].U.ki.dwFlags = 0x0006  # KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
}
[Otto.Native]::SendInput([uint32]$inputs.Length, $inputs, [Otto.INPUT]::Size) | Out-Null
`);
  }
  return parts.join('\n');
}

interface KeyCombo { vk: number; ctrl: boolean; shift: boolean; alt: boolean; win: boolean; }

function parseCombo(combo: string): KeyCombo {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  let ctrl = false, shift = false, alt = false, win = false;
  let keyName = '';
  for (const p of parts) {
    if (['ctrl', 'control'].includes(p)) ctrl = true;
    else if (['shift'].includes(p)) shift = true;
    else if (['alt', 'option', 'opt', 'meta'].includes(p)) alt = true;
    else if (['win', 'super'].includes(p)) win = true;
    else if (['cmd', 'command'].includes(p)) {
      // Best-effort mac→win mapping: shortcuts using cmd almost always mean
      // ctrl on Windows (copy/paste/save/etc). Users can override with an
      // explicit "ctrl+..." combo if they want the literal chord.
      ctrl = true;
    }
    else keyName = p;
  }
  let vk = VK[keyName];
  if (vk == null) {
    if (keyName.length !== 1) throw new Error(`unknown key: "${keyName}" in combo "${combo}"`);
    // Placeholder — the PS side calls VkKeyScan on the literal char at
    // runtime to get the right VK for the active keyboard layout, and picks
    // up whether Shift is required (high byte of the return value).
    vk = -1;
  }
  return { vk, ctrl, shift, alt, win };
}

function keyScript(combo: string): string {
  const c = parseCombo(combo);
  const literalChar = c.vk === -1 ? combo.toLowerCase().split('+').pop()! : null;
  // Emit a chord: modifier-downs, then vk down/up, then modifier-ups (reverse
  // order). Uses SendInput so the events are treated as one hardware batch.
  const setupChar = literalChar
    ? `
$scan = [Otto.Native]::VkKeyScan([char]${pshSingleQuote(literalChar)})
$vk = [int]($scan -band 0xFF)
$shiftNeeded = (($scan -shr 8) -band 1) -ne 0
`
    : `
$vk = ${c.vk}
$shiftNeeded = $false
`;
  const extended = c.vk !== -1 && EXTENDED_VKS.has(c.vk);
  return `
${setupChar}
$flagsDown = 0
$flagsUp = 0x0002
${extended ? '$flagsDown = $flagsDown -bor 0x0001; $flagsUp = $flagsUp -bor 0x0001' : ''}
$mods = @()
if (${c.ctrl})  { $mods += 0x11 }  # VK_CONTROL
if (${c.alt})   { $mods += 0x12 }  # VK_MENU (alt)
if (${c.shift} -or $shiftNeeded) { $mods += 0x10 }  # VK_SHIFT
if (${c.win})   { $mods += 0x5B }  # VK_LWIN
$total = $mods.Length * 2 + 2
$inputs = New-Object 'Otto.INPUT[]' $total
$i = 0
foreach ($m in $mods) {
  $inputs[$i].type = 1
  $inputs[$i].U.ki.wVk = [uint16]$m
  $i++
}
$inputs[$i].type = 1
$inputs[$i].U.ki.wVk = [uint16]$vk
$inputs[$i].U.ki.dwFlags = [uint32]$flagsDown
$i++
$inputs[$i].type = 1
$inputs[$i].U.ki.wVk = [uint16]$vk
$inputs[$i].U.ki.dwFlags = [uint32]$flagsUp
$i++
$rev = [array]$mods.Clone(); [array]::Reverse($rev)
foreach ($m in $rev) {
  $inputs[$i].type = 1
  $inputs[$i].U.ki.wVk = [uint16]$m
  $inputs[$i].U.ki.dwFlags = 0x0002  # KEYEVENTF_KEYUP
  $i++
}
[Otto.Native]::SendInput([uint32]$inputs.Length, $inputs, [Otto.INPUT]::Size) | Out-Null
`;
}

// ---------------------------------------------------------------------------
// Screenshot — System.Drawing.Graphics.CopyFromScreen + cursor overlay
// ---------------------------------------------------------------------------

function screenshotScript(region: { x: number; y: number; w: number; h: number } | null, tmp: string): string {
  const setupRegion = region
    ? `
$srcX = ${region.x}
$srcY = ${region.y}
$w = ${region.w}
$h = ${region.h}
`
    : `
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$srcX = $b.X
$srcY = $b.Y
$w = $b.Width
$h = $b.Height
`;
  // Cursor overlay: fetch the current cursor icon, translate its screen-space
  // hotspot into image-space coordinates, and DrawIconEx onto the bitmap's
  // Graphics context. Matches Spectacle -p / screencapture -C so the model
  // can self-correct on the next click. Skipped silently if the cursor isn't
  // showing (CURSOR_SHOWING flag bit 0) or falls outside the capture region.
  return `
${setupRegion}
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($srcX, $srcY, 0, 0, (New-Object System.Drawing.Size($w, $h)))

$ci = New-Object Otto.CURSORINFO
$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
if ([Otto.Native]::GetCursorInfo([ref]$ci) -and ($ci.flags -band 1)) {
  $ii = New-Object Otto.ICONINFO
  if ([Otto.Native]::GetIconInfo($ci.hCursor, [ref]$ii)) {
    $cx = $ci.ptScreenPos.X - $srcX - $ii.xHotspot
    $cy = $ci.ptScreenPos.Y - $srcY - $ii.yHotspot
    if ($cx -gt -64 -and $cy -gt -64 -and $cx -lt $w -and $cy -lt $h) {
      $hdc = $g.GetHdc()
      try {
        [Otto.Native]::DrawIconEx($hdc, $cx, $cy, $ci.hCursor, 0, 0, 0, [System.IntPtr]::Zero, 3) | Out-Null
      } finally {
        $g.ReleaseHdc($hdc)
      }
    }
    if ($ii.hbmMask -ne [System.IntPtr]::Zero) { [Otto.Native]::DeleteObject($ii.hbmMask) | Out-Null }
    if ($ii.hbmColor -ne [System.IntPtr]::Zero) { [Otto.Native]::DeleteObject($ii.hbmColor) | Out-Null }
  }
}

$bmp.Save(${pshSingleQuote(tmp)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
}

// ---------------------------------------------------------------------------
// Window geometry via EnumWindows / GetWindowRect
// ---------------------------------------------------------------------------

function resolveWindowGeometryScript(name: string): string {
  const needle = pshSingleQuote(name.toLowerCase());
  return `
$needle = ${needle}
$hit = [System.IntPtr]::Zero
$cb = [Otto.EnumWindowsProc] {
  param($h, $l)
  if (-not [Otto.Native]::IsWindowVisible($h)) { return $true }
  $len = [Otto.Native]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [Otto.Native]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  $t = $sb.ToString().ToLower()
  if ($t.Contains($needle)) {
    $script:hit = $h
    return $false
  }
  return $true
}
[Otto.Native]::EnumWindows($cb, [System.IntPtr]::Zero) | Out-Null
if ($hit -eq [System.IntPtr]::Zero) { throw 'no window matches' }
$r = New-Object Otto.RECT
[Otto.Native]::GetWindowRect($hit, [ref]$r) | Out-Null
"$($r.Left),$($r.Top),$($r.Right - $r.Left),$($r.Bottom - $r.Top)"
`;
}

// ---------------------------------------------------------------------------
// Win32Adapter
// ---------------------------------------------------------------------------

export class Win32Adapter implements PlatformAdapter {
  readonly name = 'win32';

  private psHost: Win32PsHost = getWin32PsHost();

  detectDisplayServer(): DisplayServer {
    return 'unknown';
  }

  defaultHotkey(): string {
    // Windows reserves Win+<key> chords for the shell (Win+Space swaps input
    // methods, Win+D shows desktop, etc.), so we avoid them entirely. Ctrl+
    // Shift+Space is uncommon enough in common apps to be safe.
    return isDevInstance() ? 'Ctrl+Shift+Alt+Space' : 'Ctrl+Shift+Space';
  }

  shell = {
    spawnShell: (command: string, cwd: string): ShellChild => {
      const child = nodeSpawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd,
        env: this.shell.composeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
          child.once('error', () => resolve({ exitCode: -1, signal: null }));
        }
      );
      return {
        pid: child.pid ?? -1,
        stdout: child.stdout!,
        stderr: child.stderr!,
        kill: (_signal: NodeJS.Signals) => child.kill(),
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
      await this.psHost.run(screenshotScript(region ?? null, tmp), 30_000);
      try {
        const bytes = await fsp.readFile(tmp);
        const { width, height } = this.readPngDims(bytes);
        const origin = region
          ? { x: region.x, y: region.y }
          : { x: bounds.x, y: bounds.y };
        return { bytes, width, height, monitors, origin };
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
    move: async (x, y) => { await this.psHost.run(moveScript(x, y)); },
    scroll: async (dx, dy, x?, y?) => {
      const s = scrollScript(dx, dy, x, y);
      if (s) await this.psHost.run(s);
    },
    click: async (x, y, button) => { await this.psHost.run(clickScript(x, y, button)); },
    doubleClick: async (x, y, button) => { await this.psHost.run(doubleClickScript(x, y, button)); },
    drag: async (x1, y1, x2, y2, button) => { await this.psHost.run(dragScript(x1, y1, x2, y2, button)); },
    type: async (text: string) => { await this.psHost.run(typeScript(text)); },
    key: async (combo: string) => { await this.psHost.run(keyScript(combo)); },
  };

  private async resolveWindowGeometry(name: string): Promise<{ x: number; y: number; w: number; h: number }> {
    const out = (await this.psHost.run(resolveWindowGeometryScript(name))).trim();
    const [xs, ys, ws, hs] = out.split(',');
    if (!xs || !ys || !ws || !hs) throw new Error(`no window matches name "${name}"`);
    return { x: parseInt(xs, 10), y: parseInt(ys, 10), w: parseInt(ws, 10), h: parseInt(hs, 10) };
  }

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
