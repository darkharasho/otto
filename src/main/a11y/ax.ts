import { spawn } from 'node:child_process';
import {
  isInteractiveRole,
  type A11yBackend, type UiActResult, type UiNode, type UiOp, type UiTree, type UiTreeOptions,
  type UiWindowInfo,
} from './types';

/**
 * macOS backend over the AX API as exposed by System Events (JXA). Requires
 * the same Accessibility permission Otto already needs for input.
 *
 * Apple events are per-property round trips, so the walk fetches each
 * element's children's properties in bulk (`kids.role()` etc. — one event per
 * property per parent, not per child). Handles are index paths from the
 * process's window: `<pid>:<windowIndex>:<i>/<j>/…`, re-resolved on act.
 */

function runJxa(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('accessibility query timed out')); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().replace(/^.*execution error: /, '') || `osascript exit ${code}`));
    });
  });
}

const JXA_PRELUDE = `
const se = Application('System Events');
function safe(f, d) { try { const v = f(); return v === undefined || v === null ? d : v; } catch (e) { return d; } }
function clean(t) { return String(t === undefined || t === null ? '' : t).replace(/\\s+/g, ' ').trim().slice(0, 160); }
function listWindows() {
  const out = [];
  const procs = se.processes.whose({ backgroundOnly: false })();
  for (const p of procs) {
    const pid = safe(() => p.unixId(), 0);
    const app = safe(() => p.name(), '');
    const front = safe(() => p.frontmost(), false);
    const titles = safe(() => p.windows.name(), []);
    titles.forEach((t, i) => out.push({ pid, index: i, app, title: clean(t), active: front && i === 0 }));
  }
  return out;
}
function resolveWindow(pid, index) {
  const p = se.processes.whose({ unixId: pid })()[0];
  if (!p) throw new Error('process is gone; call ui_tree again');
  return p.windows[index];
}
`;

export function treeJxa(opts: UiTreeOptions): string {
  return `${JXA_PRELUDE}
const opts = ${JSON.stringify({ window: opts.window ?? null, maxNodes: opts.maxNodes })};
const wins = listWindows();
let win;
if (opts.window) {
  const n = opts.window.toLowerCase();
  const hits = wins.filter((w) => w.title.toLowerCase().includes(n) || w.app.toLowerCase().includes(n));
  win = hits.find((w) => w.active) || hits[0];
  if (!win) throw new Error('no window matches "' + opts.window + '". Windows: ' + wins.filter((w) => w.title).map((w) => '"' + w.title + '" (' + w.app + ')').slice(0, 25).join(', '));
} else {
  win = wins.find((w) => w.active);
  if (!win) throw new Error('no active window; pass window (title or app name)');
}
const root = resolveWindow(win.pid, win.index);
const nodes = [];
let truncated = false;
function props(coll) {
  return {
    role: safe(() => coll.role(), []),
    title: safe(() => coll.title(), []),
    name: safe(() => coll.name(), []),
    desc: safe(() => coll.description(), []),
    value: safe(() => coll.value(), []),
    pos: safe(() => coll.position(), []),
    size: safe(() => coll.size(), []),
    enabled: safe(() => coll.enabled(), []),
    focused: safe(() => coll.focused(), []),
  };
}
function walk(el, path, depth) {
  if (nodes.length >= opts.maxNodes) { truncated = true; return; }
  const kids = el.uiElements;
  const n = safe(() => kids.length, 0);
  if (!n) return;
  const p = props(kids);
  for (let i = 0; i < n; i++) {
    if (nodes.length >= opts.maxNodes) { truncated = true; return; }
    const childPath = path ? path + '/' + i : String(i);
    const pos = p.pos[i] || null, size = p.size[i] || null;
    const v = p.value[i];
    nodes.push({
      handle: win.pid + ':' + win.index + ':' + childPath,
      depth: depth,
      role: clean(p.role[i]),
      name: clean(p.title[i] || p.name[i] || p.desc[i]),
      value: (typeof v === 'string' || typeof v === 'number') ? clean(v) : '',
      states: [p.enabled[i] === false ? 'disabled' : '', p.focused[i] === true ? 'focused' : ''].filter(Boolean),
      bounds: pos && size ? { x: pos[0], y: pos[1], w: size[0], h: size[1] } : null,
    });
    walk(kids[i], childPath, depth + 1);
  }
}
nodes.push({ handle: win.pid + ':' + win.index + ':', depth: 0, role: 'AXWindow', name: win.title, value: '', states: [], bounds: null });
walk(root, '', 1);
JSON.stringify({ window: win, nodes, truncated });
`;
}

function resolveJs(handle: string): string {
  const [pid, index, path] = handle.split(':');
  if (pid === undefined || index === undefined || path === undefined) throw new Error(`invalid element handle "${handle}"`);
  const steps = path ? path.split('/').map((i) => `.uiElements[${parseInt(i, 10)}]`).join('') : '';
  return `resolveWindow(${parseInt(pid, 10)}, ${parseInt(index, 10)})${steps}`;
}

export function actJxa(handle: string, op: UiOp, text?: string): string {
  return `${JXA_PRELUDE}
const el = ${resolveJs(handle)};
const op = ${JSON.stringify(op)};
const text = ${JSON.stringify(text ?? null)};
function pointer() {
  const pos = el.position(), size = el.size();
  return JSON.stringify({ method: 'pointer-click', pointer: { x: Math.round(pos[0] + size[0] / 2), y: Math.round(pos[1] + size[1] / 2) } });
}
let result;
if (op === 'set_text') {
  try { el.value = text; result = JSON.stringify({ method: 'set-value' }); }
  catch (e) { try { el.focused = true; } catch (e2) {} result = JSON.stringify({ method: 'focus-then-type' }); }
} else if (op === 'focus') {
  try { el.focused = true; result = JSON.stringify({ method: 'set-focus' }); } catch (e) { result = pointer(); }
} else if (op === 'click') {
  result = pointer();
} else {
  const names = safe(() => el.actions.name(), []);
  const pick = ['AXPress', 'AXConfirm', 'AXPick', 'AXOpen', 'AXShowMenu'].find((n) => names.includes(n));
  if (pick) { el.actions.byName(pick).perform(); result = JSON.stringify({ method: 'action:' + pick }); }
  else result = pointer();
}
result;
`;
}

interface RawTree {
  window: { pid: number; index: number; app: string; title: string; active: boolean };
  nodes: Array<Omit<UiNode, 'actions' | 'bounds' | 'value'> & { value: string; bounds: UiNode['bounds'] | null }>;
  truncated: boolean;
}

export function parseAxTree(json: string, query?: string): UiTree {
  const raw = JSON.parse(json) as RawTree;
  const window: UiWindowInfo = {
    handle: `${raw.window.pid}:${raw.window.index}:`,
    app: raw.window.app,
    title: raw.window.title,
    active: raw.window.active,
  };
  const q = query?.toLowerCase();
  const nodes: UiNode[] = raw.nodes
    .map((n) => ({
      handle: n.handle,
      depth: n.depth,
      role: n.role.replace(/^AX/, ''),
      name: n.name,
      value: n.value || undefined,
      states: n.states,
      bounds: n.bounds ?? undefined,
      actions: [],
    }))
    // Drop unnamed structural groups; keep anything interactive or labelled.
    .filter((n, i) => i === 0 || n.name || n.value || isInteractiveRole(n.role))
    .filter((n, i) => !q || i === 0 || `${n.role} ${n.name} ${n.value ?? ''}`.toLowerCase().includes(q));
  return { window, nodes, truncated: raw.truncated, boundsReliable: true, notes: [] };
}

export class AxBackend implements A11yBackend {
  readonly name = 'ax';

  async windows(): Promise<UiWindowInfo[]> {
    const out = await runJxa(`${JXA_PRELUDE}\nJSON.stringify(listWindows());`, 20_000);
    return (JSON.parse(out) as Array<{ pid: number; index: number; app: string; title: string; active: boolean }>)
      .map((w) => ({ handle: `${w.pid}:${w.index}:`, app: w.app, title: w.title, active: w.active }));
  }

  async tree(opts: UiTreeOptions): Promise<UiTree> {
    return parseAxTree(await runJxa(treeJxa(opts), 45_000), opts.query);
  }

  async act(handle: string, op: UiOp, text?: string): Promise<UiActResult> {
    return JSON.parse(await runJxa(actJxa(handle, op, text), 15_000)) as UiActResult;
  }
}
