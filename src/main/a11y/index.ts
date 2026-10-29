import { spawn } from 'node:child_process';
import type { A11yBackend, Rect, UiActResult, UiNode, UiOp, UiTree, UiTreeOptions } from './types';

export type { A11yBackend, UiOp, UiTree } from './types';

/**
 * Front door for the ui_tree / ui_act tools: picks the OS backend, swaps the
 * backends' long handles for short element ids (`e12`) the model can quote
 * cheaply, fixes up Wayland's window-relative bounds, and renders a tree as
 * compact indented text.
 */

let backend: A11yBackend | null = null;

export async function getA11yBackend(): Promise<A11yBackend> {
  if (backend) return backend;
  if (process.platform === 'linux') {
    const { createAtspiBackend } = await import('./atspi');
    backend = createAtspiBackend();
  } else if (process.platform === 'win32') {
    const [{ UiaBackend }, { getWin32PsHost }] = await Promise.all([
      import('./uia'),
      import('../platform/win32-ps-host'),
    ]);
    backend = new UiaBackend(getWin32PsHost());
  } else if (process.platform === 'darwin') {
    const { AxBackend } = await import('./ax');
    backend = new AxBackend();
  } else {
    throw new Error(`no accessibility backend for ${process.platform}`);
  }
  return backend;
}

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------

interface Ref { handle: string; offset: { dx: number; dy: number }; }
const MAX_REFS = 4_000;
const refs = new Map<string, Ref>();
let seq = 0;

function remember(handle: string, offset: { dx: number; dy: number }): string {
  const id = `e${(seq += 1)}`;
  refs.set(id, { handle, offset });
  // Map iteration is insertion-ordered: drop the oldest once over the cap.
  while (refs.size > MAX_REFS) refs.delete(refs.keys().next().value!);
  return id;
}

export function resolveRef(id: string): Ref {
  const ref = refs.get(id.trim());
  if (!ref) throw new Error(`unknown element "${id}" — ids come from the latest ui_tree; call it again`);
  return ref;
}

// Test seam.
export function __resetRefsForTest(): void {
  refs.clear();
  seq = 0;
}

// ---------------------------------------------------------------------------
// Wayland offset: native Wayland apps report bounds relative to their own
// surface. KWin knows where the window is; translate so bounds become real
// virtual-desktop coords usable for clicks.
// ---------------------------------------------------------------------------

function kdotool(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('kdotool', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('kdotool timed out')); }, 3_000);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`kdotool exit ${code}`));
    });
  });
}

async function kwinWindowRect(title: string): Promise<Rect | null> {
  // kdotool's --name is a regex; escape the literal title.
  const pattern = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = (await kdotool(['search', '--name', pattern])).split('\n').map((s) => s.trim()).find(Boolean);
  if (!id) return null;
  const out = await kdotool(['getwindowgeometry', id]);
  const pos = /Position:\s*(-?\d+)\s*,\s*(-?\d+)/.exec(out);
  const geo = /Geometry:\s*(\d+)\s*x\s*(\d+)/.exec(out);
  if (!pos || !geo) return null;
  return { x: +pos[1]!, y: +pos[2]!, w: +geo[1]!, h: +geo[2]! };
}

/**
 * Offset from surface-relative to desktop coords, given the window rect from
 * KWin (frame, may include decorations) and the frame rect the app reports
 * (surface, origin 0,0). Decorations are assumed to be side borders split
 * evenly plus a title bar on top.
 */
export function surfaceOffset(kwin: Rect, surface: Rect): { dx: number; dy: number } {
  const border = Math.max(0, Math.round((kwin.w - surface.w) / 2));
  const titlebar = Math.max(0, kwin.h - surface.h - border);
  return { dx: kwin.x + border - surface.x, dy: kwin.y + titlebar - surface.y };
}

async function waylandOffset(tree: UiTree): Promise<{ dx: number; dy: number } | null> {
  if (process.platform !== 'linux' || (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() !== 'wayland') return null;
  const root = tree.nodes[0]?.bounds;
  // Surface-relative trees put the window at (0,0); XWayland apps already
  // report real screen coords and are left alone.
  if (!root || root.x !== 0 || root.y !== 0 || !tree.window.title) return null;
  const kwin = await kwinWindowRect(tree.window.title).catch(() => null);
  return kwin ? surfaceOffset(kwin, root) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderedTree {
  text: string;
  nodeCount: number;
}

function shift(b: Rect | undefined, o: { dx: number; dy: number }): Rect | undefined {
  return b ? { x: b.x + o.dx, y: b.y + o.dy, w: b.w, h: b.h } : undefined;
}

export function renderTree(tree: UiTree, ids: string[], boundsNote: string | null): string {
  const lines: string[] = [];
  lines.push(`window: "${tree.window.title}" (${tree.window.app})${tree.window.active ? ' [active]' : ''}`);
  for (const note of tree.notes) lines.push(`note: ${note}`);
  if (boundsNote) lines.push(`note: ${boundsNote}`);
  tree.nodes.forEach((n: UiNode, i) => {
    const indent = '  '.repeat(Math.min(n.depth, 12));
    const parts = [`${ids[i]} ${n.role}`];
    if (n.name) parts.push(JSON.stringify(n.name));
    if (n.value !== undefined && n.value !== n.name) parts.push(`=${JSON.stringify(n.value)}`);
    if (n.states.length) parts.push(`[${n.states.join(',')}]`);
    if (n.bounds) parts.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}`);
    lines.push(indent + parts.join(' '));
  });
  if (tree.truncated) lines.push('… truncated: narrow with `query`, or raise `max_nodes`.');
  return lines.join('\n');
}

export async function uiTree(opts: UiTreeOptions): Promise<RenderedTree> {
  const be = await getA11yBackend();
  const tree = await be.tree(opts);
  const offset = (await waylandOffset(tree)) ?? { dx: 0, dy: 0 };
  const shifted = offset.dx !== 0 || offset.dy !== 0;
  const nodes = tree.nodes.map((n) => ({ ...n, bounds: shift(n.bounds, offset) }));
  const ids = nodes.map((n) => remember(n.handle, offset));
  let boundsNote: string | null = null;
  if (shifted) {
    boundsNote = 'bounds are translated from window-relative using the window position KWin reports (accurate unless the window has unusual decorations).';
    tree.notes = tree.notes.filter((n) => !n.startsWith('Wayland:'));
  } else if (!tree.boundsReliable) {
    boundsNote = 'bounds may be window-relative; prefer ui_act over clicking coordinates.';
    tree.notes = tree.notes.filter((n) => !n.startsWith('Wayland:'));
  }
  return { text: renderTree({ ...tree, nodes }, ids, boundsNote), nodeCount: nodes.length };
}

export async function uiWindows(): Promise<string> {
  const be = await getA11yBackend();
  const wins = await be.windows();
  return wins
    .filter((w) => w.title)
    .map((w) => `${w.active ? '* ' : '  '}"${w.title}" (${w.app})`)
    .join('\n') || '(no accessible windows)';
}

/**
 * Operate an element by id. When the backend can only offer a coordinate
 * click, the returned `pointer` is already in virtual-desktop coords; the
 * caller performs it through the input adapter.
 */
export async function uiAct(id: string, op: UiOp, text?: string): Promise<UiActResult> {
  const ref = resolveRef(id);
  const be = await getA11yBackend();
  const r = await be.act(ref.handle, op, text);
  if (r.pointer) r.pointer = { x: r.pointer.x + ref.offset.dx, y: r.pointer.y + ref.offset.dy };
  return r;
}
