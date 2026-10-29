import type { Win32PsHost } from '../platform/win32-ps-host';
import type {
  A11yBackend, Rect, UiActResult, UiNode, UiOp, UiTree, UiTreeOptions, UiWindowInfo,
} from './types';

/**
 * Windows backend over UI Automation (System.Windows.Automation), run inside
 * the adapter's persistent PowerShell host. Elements found by a tree walk are
 * cached in `$global:OttoUia` keyed by short ids, so `act` operates the exact
 * AutomationElement without re-searching. The cache is replaced on every
 * tree call — ids from an older tree are invalid.
 *
 * Coordinates come from the same PowerShell process that performs Otto's
 * clicks, so bounds and pointer input share one DPI context.
 */

const SEP = '\u001f';

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

const PRELUDE = `
if (-not ('System.Windows.Automation.AutomationElement' -as [Type])) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
}
if (-not ('Otto.Fg' -as [Type])) {
  Add-Type -TypeDefinition 'namespace Otto { public static class Fg { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); } }'
}
$A = [System.Windows.Automation.AutomationElement]
$S = [char]0x1f
function OttoClean([string]$t) { if ($null -eq $t) { return '' }; return ($t -replace "[\\r\\n\\t$S]", ' ').Trim() }
function OttoWindows {
  $fg = [Otto.Fg]::GetForegroundWindow().ToInt64()
  $out = @()
  foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $c = $w.Current
      $app = ''
      try { $app = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
      $out += [pscustomobject]@{ El = $w; Title = (OttoClean $c.Name); App = $app; Active = ($c.NativeWindowHandle -eq $fg) }
    } catch {}
  }
  return $out
}
`;

export function treeScript(opts: UiTreeOptions): string {
  const needle = opts.window ? psQuote(opts.window.toLowerCase()) : '$null';
  return `${PRELUDE}
$needle = ${needle}
$wins = OttoWindows
if ($needle) {
  $hits = @($wins | Where-Object { $_.Title.ToLower().Contains($needle) -or $_.App.ToLower().Contains($needle) })
  $win = ($hits | Where-Object { $_.Active } | Select-Object -First 1)
  if (-not $win) { $win = $hits | Select-Object -First 1 }
  if (-not $win) { throw ("no window matches " + $needle + ". Windows: " + (($wins | Where-Object { $_.Title } | ForEach-Object { '"' + $_.Title + '" (' + $_.App + ')' }) -join ', ')) }
} else {
  $win = $wins | Where-Object { $_.Active } | Select-Object -First 1
  if (-not $win) { throw 'no active window; pass window (title or app name)' }
}
$global:OttoUia = @{}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$max = ${Math.max(1, Math.floor(opts.maxNodes))}
$offscreenOk = ${opts.includeOffscreen ? '$true' : '$false'}
$count = 0
$truncated = $false
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('W' + $S + $win.Title + $S + $win.App + $S + $win.Active)
$stack = New-Object System.Collections.Stack
$stack.Push(@($win.El, 0))
while ($stack.Count -gt 0) {
  $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]
  if ($count -ge $max) { $truncated = $true; break }
  try { $c = $el.Current } catch { continue }
  if ($depth -gt 0 -and $c.IsOffscreen -and -not $offscreenOk) { continue }
  $count++
  $id = 'u' + $count
  $global:OttoUia[$id] = $el
  $states = @()
  if (-not $c.IsEnabled) { $states += 'disabled' }
  if ($c.HasKeyboardFocus) { $states += 'focused' }
  $actions = @()
  $value = ''
  foreach ($p in $el.GetSupportedPatterns()) {
    switch ($p.ProgrammaticName) {
      'InvokePatternIdentifiers.Pattern' { $actions += 'invoke' }
      'TogglePatternIdentifiers.Pattern' {
        $actions += 'toggle'
        try { if ($el.GetCurrentPattern($p).Current.ToggleState -eq 'On') { $states += 'checked' } } catch {}
      }
      'SelectionItemPatternIdentifiers.Pattern' {
        $actions += 'select'
        try { if ($el.GetCurrentPattern($p).Current.IsSelected) { $states += 'selected' } } catch {}
      }
      'ExpandCollapsePatternIdentifiers.Pattern' {
        $actions += 'expand'
        try { $states += ([string]$el.GetCurrentPattern($p).Current.ExpandCollapseState).ToLower() } catch {}
      }
      'ValuePatternIdentifiers.Pattern' {
        try {
          $vp = $el.GetCurrentPattern($p).Current
          $value = OttoClean $vp.Value
          if (-not $vp.IsReadOnly) { $actions += 'set_value'; $states += 'editable' }
        } catch {}
      }
      'RangeValuePatternIdentifiers.Pattern' {
        try { $value = [string]$el.GetCurrentPattern($p).Current.Value } catch {}
      }
    }
  }
  $r = $c.BoundingRectangle
  $b = ''
  if (-not $r.IsEmpty -and $r.Width -gt 0) { $b = '' + [int]$r.X + ',' + [int]$r.Y + ',' + [int]$r.Width + ',' + [int]$r.Height }
  $role = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
  $lines.Add('N' + $S + $id + $S + $depth + $S + $role + $S + (OttoClean $c.Name) + $S + $value + $S + ($states -join ',') + $S + $b + $S + ($actions -join ','))
  $kids = New-Object System.Collections.Generic.List[object]
  try {
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) { $kids.Add($child); $child = $walker.GetNextSibling($child) }
  } catch {}
  for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($depth + 1))) }
}
if ($truncated) { $lines.Add('T') }
$lines -join [char]10
`;
}

export function windowsScript(): string {
  return `${PRELUDE}
(OttoWindows | ForEach-Object { 'W' + $S + $_.Title + $S + $_.App + $S + $_.Active }) -join [char]10
`;
}

export function actScript(handle: string, op: UiOp, text?: string): string {
  return `${PRELUDE}
$el = $null
if ($global:OttoUia) { $el = $global:OttoUia[${psQuote(handle)}] }
if (-not $el) { throw 'unknown element id; call ui_tree again' }
$op = ${psQuote(op)}
$text = ${text === undefined ? '$null' : psQuote(text)}
function OttoPattern($el, $name) {
  foreach ($p in $el.GetSupportedPatterns()) { if ($p.ProgrammaticName -eq ($name + 'PatternIdentifiers.Pattern')) { return $el.GetCurrentPattern($p) } }
  return $null
}
function OttoPointer($el) {
  try { $pt = $el.GetClickablePoint(); return 'pointer-click' + $S + [int]$pt.X + $S + [int]$pt.Y } catch {}
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { throw 'element has no on-screen bounds' }
  return 'pointer-click' + $S + [int]($r.X + $r.Width / 2) + $S + [int]($r.Y + $r.Height / 2)
}
if ($op -eq 'set_text') {
  $vp = OttoPattern $el 'Value'
  if ($vp -and -not $vp.Current.IsReadOnly) { $vp.SetValue($text); 'set-value' }
  else { try { $el.SetFocus() } catch {}; 'focus-then-type' }
} elseif ($op -eq 'focus') {
  try { $el.SetFocus(); 'set-focus' } catch { OttoPointer $el }
} elseif ($op -eq 'click') {
  OttoPointer $el
} else {
  $p = OttoPattern $el 'Invoke'
  if ($p) { $p.Invoke(); 'invoke' }
  else {
    $p = OttoPattern $el 'Toggle'
    if ($p) { $p.Toggle(); 'toggle' }
    else {
      $p = OttoPattern $el 'SelectionItem'
      if ($p) { $p.Select(); 'select' }
      else {
        $p = OttoPattern $el 'ExpandCollapse'
        if ($p) {
          if ($p.Current.ExpandCollapseState -eq 'Collapsed') { $p.Expand(); 'expand' } else { $p.Collapse(); 'collapse' }
        } else { OttoPointer $el }
      }
    }
  }
}
`;
}

function parseBounds(s: string | undefined): Rect | undefined {
  if (!s) return undefined;
  const [x, y, w, h] = s.split(',').map((n) => parseInt(n, 10));
  if ([x, y, w, h].some((n) => n === undefined || Number.isNaN(n))) return undefined;
  return { x: x!, y: y!, w: w!, h: h! };
}

export function parseTreeOutput(out: string): UiTree {
  let window: UiWindowInfo | null = null;
  const nodes: UiNode[] = [];
  let truncated = false;
  for (const line of out.split(/\r?\n/)) {
    const f = line.split(SEP);
    if (f[0] === 'W') {
      window = { handle: '', title: f[1] ?? '', app: f[2] ?? '', active: f[3] === 'True' };
    } else if (f[0] === 'N') {
      nodes.push({
        handle: f[1] ?? '',
        depth: parseInt(f[2] ?? '0', 10),
        role: f[3] ?? '',
        name: f[4] ?? '',
        value: f[5] ? f[5] : undefined,
        states: f[6] ? f[6].split(',').filter(Boolean) : [],
        bounds: parseBounds(f[7]),
        actions: f[8] ? f[8].split(',').filter(Boolean) : [],
      });
    } else if (f[0] === 'T') {
      truncated = true;
    }
  }
  if (!window) throw new Error('UI Automation returned no window');
  return { window, nodes, truncated, boundsReliable: true, notes: [] };
}

export function parseActOutput(out: string): UiActResult {
  const f = out.trim().split(/\r?\n/).pop()!.split(SEP);
  const method = f[0] ?? '';
  if (method === 'pointer-click') {
    return { method, pointer: { x: parseInt(f[1] ?? '0', 10), y: parseInt(f[2] ?? '0', 10) } };
  }
  return { method };
}

export class UiaBackend implements A11yBackend {
  readonly name = 'uia';
  constructor(private readonly host: Win32PsHost) {}

  async windows(): Promise<UiWindowInfo[]> {
    const out = await this.host.run(windowsScript(), 20_000);
    return out.split(/\r?\n/).filter((l) => l.startsWith('W')).map((l) => {
      const f = l.split(SEP);
      return { handle: '', title: f[1] ?? '', app: f[2] ?? '', active: f[3] === 'True' };
    });
  }

  async tree(opts: UiTreeOptions): Promise<UiTree> {
    const tree = parseTreeOutput(await this.host.run(treeScript(opts), 45_000));
    if (opts.query) {
      const q = opts.query.toLowerCase();
      tree.nodes = tree.nodes
        .filter((n, i) => i === 0 || `${n.role} ${n.name} ${n.value ?? ''}`.toLowerCase().includes(q))
        .map((n, i) => ({ ...n, depth: i === 0 ? 0 : 1 }));
    }
    return tree;
  }

  async act(handle: string, op: UiOp, text?: string): Promise<UiActResult> {
    return parseActOutput(await this.host.run(actScript(handle, op, text), 15_000));
  }
}
