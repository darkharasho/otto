import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../logger';

// Sentinels used to frame script boundaries and outcomes over the PS host's
// stdio channel. They include a random suffix so a script's own output can't
// accidentally match a marker (even if a user script literally echoes the
// prefix, the suffix nonce makes collision practically impossible).
const NONCE = Math.random().toString(36).slice(2, 10);
const EOS = `__OTTO_EOS_${NONCE}__`;
const OK = `__OTTO_OK_${NONCE}__`;
const ERR_PREFIX = `__OTTO_ERR_${NONCE}__:`;

/**
 * P/Invoke preamble sent once at host startup. All subsequent scripts assume
 * `[Otto.Native]` and the shared structs exist. Compiling C# is expensive
 * (~600ms), so amortizing this over the process lifetime is the whole point
 * of the persistent host.
 */
const PREAMBLE = `
$ErrorActionPreference = 'Stop'
if (-not ('Otto.Native' -as [Type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Otto {
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
  public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
    public static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } }
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static class Native {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cxWidth, int cyHeight, uint istepIfAniCur, IntPtr hbrFlickerFreeDraw, uint diFlags);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  }
}
"@
}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
`;

interface PendingCall {
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  script: string;
}

/**
 * Persistent powershell.exe process for the win32 adapter. Amortizes the
 * ~500ms cold start of `powershell.exe` and the ~600ms Add-Type compile of
 * the P/Invoke preamble over the app lifetime — subsequent scripts run in
 * single-digit ms.
 *
 * Concurrency model: at most one script runs at a time. Callers are queued
 * FIFO. The host is single-threaded on the PowerShell side (one Invoke-
 * Expression, one output stream) so serializing here matches its semantics
 * exactly and makes output framing tractable.
 */
export class Win32PsHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private queue: PendingCall[] = [];
  private inFlight: PendingCall | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  private shuttingDown = false;

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.spawn();
    return this.ready;
  }

  private async spawn(): Promise<void> {
    // The REPL body: after installing the P/Invoke preamble, loop reading
    // stdin lines into a buffer until the EOS sentinel, Invoke-Expression
    // the buffer, then emit either the OK or ERR sentinel. Exits cleanly
    // when stdin closes (Otto shutdown).
    //
    // We pass this whole script via -EncodedCommand rather than writing it
    // to stdin: with -Command - or -File -, PowerShell reads stdin as its
    // script source, and our REPL's own [Console]::In.ReadLine() calls
    // would fight it for the same handle.
    const repl = `
${PREAMBLE}
while ($true) {
  $script = New-Object System.Text.StringBuilder
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { exit 0 }
    if ($line -eq '${EOS}') { break }
    [void]$script.AppendLine($line)
  }
  try {
    $result = Invoke-Expression $script.ToString()
    if ($null -ne $result) {
      $result | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
    }
    [Console]::Out.WriteLine('${OK}')
  } catch {
    $msg = $_.Exception.Message -replace "\`r?\`n", ' | '
    [Console]::Out.WriteLine('${ERR_PREFIX}' + $msg)
  }
  [Console]::Out.Flush()
}
`;
    const encoded = Buffer.from(repl, 'utf16le').toString('base64');
    const child = nodeSpawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (err) => {
      logger.error(`win32 ps host: spawn error: ${err.message}`);
    });
    // No handshake — the first real call will land after the preamble is
    // parsed and the REPL loop starts, and its output framing is enough to
    // confirm the host is alive. Extra readiness ping would just add latency.
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const rawLine = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const line = rawLine.replace(/\r$/, '');
      const call = this.inFlight;
      if (!call) {
        // Output that arrives when nothing is in flight is either the boot
        // banner or a stray. Ignore unless it's the OK sentinel — which
        // would indicate a lost message. Log noisy stderr instead.
        continue;
      }
      if (line === OK) {
        this.finishInFlight(null);
      } else if (line.startsWith(ERR_PREFIX)) {
        this.finishInFlight(new Error(line.slice(ERR_PREFIX.length)));
      } else {
        // Accumulate into the call's output. We stash on the pending call
        // itself via a mutable property.
        (call as PendingCall & { out?: string }).out =
          ((call as PendingCall & { out?: string }).out ?? '') + line + '\n';
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    // Keep only the last 4 KB of stderr for diagnostics — enough for one
    // typical PS error, not enough to leak on a runaway warning stream.
    if (this.stderrBuf.length > 4096) {
      this.stderrBuf = this.stderrBuf.slice(-4096);
    }
  }

  private onExit(code: number | null): void {
    const err = new Error(
      `win32 ps host exited (code=${code ?? 'null'})${this.stderrBuf ? ` — stderr: ${this.stderrBuf.trim()}` : ''}`,
    );
    // Fail everyone waiting; the next call will trigger a fresh spawn.
    if (this.inFlight) {
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    for (const q of this.queue) q.reject(err);
    this.queue = [];
    this.child = null;
    this.ready = null;
    this.stdoutBuf = '';
    if (!this.shuttingDown) {
      logger.warn(err.message);
    }
  }

  private finishInFlight(err: Error | null): void {
    const call = this.inFlight;
    if (!call) return;
    this.inFlight = null;
    const out = (call as PendingCall & { out?: string }).out ?? '';
    if (err) call.reject(err);
    else call.resolve(out);
    this.pump();
  }

  private pump(): void {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    const child = this.child;
    if (!child) {
      next.reject(new Error('win32 ps host: no child process'));
      this.inFlight = null;
      return;
    }
    // Write the script and terminate with the EOS sentinel on its own line.
    child.stdin.write(next.script);
    if (!next.script.endsWith('\n')) child.stdin.write('\n');
    child.stdin.write(EOS + '\n');
  }

  /** Enqueue a script, resolve with its stdout, reject if it throws. */
  async run(script: string, timeoutMs = 15_000): Promise<string> {
    await this.ensure();
    return new Promise<string>((resolve, reject) => {
      const call: PendingCall = { script, resolve, reject };
      const timer = setTimeout(() => {
        // Timing out doesn't necessarily kill the host — PS may still be
        // running. Log and reject; the next call will re-serialize behind
        // whatever's still pending. If the host is truly stuck, the exit
        // handler (or explicit stop) will clean up.
        if (this.inFlight === call) {
          this.finishInFlight(new Error(`ps script timed out after ${timeoutMs}ms`));
        } else {
          const idx = this.queue.indexOf(call);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            call.reject(new Error(`ps script timed out in queue after ${timeoutMs}ms`));
          }
        }
      }, timeoutMs);
      call.resolve = (out) => { clearTimeout(timer); resolve(out); };
      call.reject = (err) => { clearTimeout(timer); reject(err); };
      this.queue.push(call);
      this.pump();
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    // Give PS a beat to exit cleanly; then force. Short deadline — we don't
    // want to block app shutdown on a wedged shell.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        done();
      }, 500).unref();
    });
  }
}

// Process-singleton — one PS host serves the whole app. Tests that need
// isolation can construct their own instance.
let cached: Win32PsHost | null = null;
export function getWin32PsHost(): Win32PsHost {
  if (!cached) cached = new Win32PsHost();
  return cached;
}
