import dbus, { Message, Variant, type MessageBus } from 'dbus-next';
import {
  isInteractiveRole,
  type A11yBackend, type Rect, type UiActResult, type UiNode, type UiOp, type UiTree,
  type UiTreeOptions, type UiWindowInfo,
} from './types';

/**
 * Linux backend over AT-SPI2 (the accessibility bus every GTK, Qt, Firefox
 * and — with accessibility on — Chromium/Electron app exports to). Talks
 * D-Bus directly through dbus-next; no python/pyatspi dependency.
 *
 * Apps only export their trees while `org.a11y.Status.IsEnabled` is true, so
 * the first use flips it on (running Qt/GTK/Firefox apps register within a
 * second; Chromium-based apps may need a restart).
 */

export type DbusCall = (
  dest: string, path: string, iface: string, member: string,
  signature?: string, body?: unknown[]
) => Promise<unknown[]>;

const ACC = 'org.a11y.atspi.Accessible';
const PROPS = 'org.freedesktop.DBus.Properties';
const REGISTRY = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const NULL_PATH = '/org/a11y/atspi/null';
const CALL_TIMEOUT_MS = 2_500;
const MAX_CHILDREN_PER_NODE = 400;
const MAX_TEXT = 160;
const TEXTY_ROLE = /^(paragraph|static|label|text|caption|heading|list item|description|block quote|cell)/i;

// AtspiStateType bit indices (at-spi2-core atspi-constants.h).
const S = {
  ACTIVE: 1, CHECKED: 4, COLLAPSED: 5, EDITABLE: 7, ENABLED: 8, EXPANDABLE: 9, EXPANDED: 10,
  FOCUSED: 12, PRESSED: 20, SELECTED: 23, SENSITIVE: 24, SHOWING: 25, VISIBLE: 30,
} as const;

// Preferred AT-SPI action names, most "do the obvious thing" first.
const PRESS_ACTIONS = ['click', 'press', 'activate', 'jump', 'toggle', 'open', 'select', 'switch', 'expand or contract'];

function hasState(bits: number[], idx: number): boolean {
  const word = bits[idx >> 5] ?? 0;
  return ((word >>> (idx & 31)) & 1) === 1;
}

/**
 * Prune rule for the walk. SHOWING alone is unreliable inside Firefox web
 * content (visible headers report not-showing), so ordinary nodes only need
 * VISIBLE; scrolled-off ones are culled afterwards by bounds. Frames and
 * documents still need SHOWING — that's what hides background browser tabs
 * and their entire page trees.
 */
export function isHidden(d: { role: string; states: number[] }): boolean {
  const showing = hasState(d.states, S.SHOWING);
  if (!showing && !hasState(d.states, S.VISIBLE)) return true;
  return !showing && /^(internal frame|document|embedded)/i.test(d.role);
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function stateWords(bits: number[]): string[] {
  const out: string[] = [];
  if (hasState(bits, S.FOCUSED)) out.push('focused');
  if (hasState(bits, S.CHECKED)) out.push('checked');
  if (hasState(bits, S.PRESSED)) out.push('pressed');
  if (hasState(bits, S.SELECTED)) out.push('selected');
  if (hasState(bits, S.EXPANDED)) out.push('expanded');
  else if (hasState(bits, S.EXPANDABLE) || hasState(bits, S.COLLAPSED)) out.push('collapsed');
  if (hasState(bits, S.EDITABLE)) out.push('editable');
  if (!hasState(bits, S.ENABLED) && !hasState(bits, S.SENSITIVE)) out.push('disabled');
  return out;
}

export function encodeHandle(bus: string, path: string): string {
  return `${bus}|${path}`;
}

export function decodeHandle(handle: string): { bus: string; path: string } {
  const i = handle.indexOf('|');
  if (i <= 0) throw new Error(`invalid element handle "${handle}"`);
  return { bus: handle.slice(0, i), path: handle.slice(i + 1) };
}

function unwrap(v: unknown): unknown {
  return v && typeof v === 'object' && 'value' in (v as object) && 'signature' in (v as object)
    ? (v as { value: unknown }).value
    : v;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

interface Described {
  bus: string;
  path: string;
  role: string;
  name: string;
  childCount: number;
  states: number[];
  ifaces: string[];
  bounds?: Rect;
}

interface Walked extends Described {
  parent: number;
  children: number[];
}

export class AtspiBackend implements A11yBackend {
  readonly name = 'at-spi';
  private justEnabled = false;
  private enabledChecked = false;

  constructor(private readonly call: DbusCall, private readonly enable: () => Promise<boolean>) {}

  private async q<T = unknown>(
    dest: string, path: string, iface: string, member: string, signature = '', body: unknown[] = []
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const out = await Promise.race([
        this.call(dest, path, iface, member, signature, body),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${member} timed out on ${dest}`)), CALL_TIMEOUT_MS);
        }),
      ]);
      return out[0] as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async describe(bus: string, path: string): Promise<Described> {
    const [props, role, states, ifaces] = await Promise.all([
      this.q<Record<string, unknown>>(bus, path, PROPS, 'GetAll', 's', [ACC]),
      this.q<string>(bus, path, ACC, 'GetRoleName'),
      this.q<number[]>(bus, path, ACC, 'GetState').catch(() => [] as number[]),
      this.q<string[]>(bus, path, ACC, 'GetInterfaces').catch(() => [] as string[]),
    ]);
    return {
      bus,
      path,
      role: String(role ?? ''),
      name: String(unwrap(props.Name) ?? ''),
      childCount: Number(unwrap(props.ChildCount) ?? 0),
      states: (states ?? []).map(Number),
      ifaces: ifaces ?? [],
      bounds: await this.boundsOf(bus, path, ifaces ?? []).catch(() => undefined),
    };
  }

  private async children(bus: string, path: string): Promise<Array<[string, string]>> {
    const kids = await this.q<Array<[string, string]>>(bus, path, ACC, 'GetChildren');
    return (kids ?? []).filter(([, p]) => p && p !== NULL_PATH);
  }

  async windows(): Promise<UiWindowInfo[]> {
    if (!this.enabledChecked) {
      this.justEnabled = await this.enable();
      this.enabledChecked = true;
    } else {
      this.justEnabled = false;
    }
    const apps = await this.children(REGISTRY, ROOT_PATH);
    const perApp = await Promise.all(
      apps.map(async ([bus, path]) => {
        try {
          const [appProps, frames] = await Promise.all([
            this.q<Record<string, unknown>>(bus, path, PROPS, 'GetAll', 's', [ACC]),
            this.children(bus, path),
          ]);
          const app = String(unwrap(appProps.Name) ?? '');
          const described = await Promise.all(
            frames.map(([fb, fp]) => this.describe(fb, fp).catch(() => null))
          );
          return described
            .filter((d): d is Described => !!d)
            .map((d) => ({
              handle: encodeHandle(d.bus, d.path),
              app,
              title: d.name,
              active: hasState(d.states, S.ACTIVE),
            }));
        } catch {
          return [];
        }
      })
    );
    return perApp.flat();
  }

  private pickWindow(all: UiWindowInfo[], pattern?: string): UiWindowInfo {
    if (pattern) {
      const p = pattern.toLowerCase();
      const hits = all.filter((w) => w.title.toLowerCase().includes(p) || w.app.toLowerCase().includes(p));
      const hit = hits.find((w) => w.active) ?? hits.find((w) => w.title) ?? hits[0];
      if (hit) return hit;
      throw new Error(
        `no accessible window matches "${pattern}". Accessible windows: ` +
          all.filter((w) => w.title).map((w) => `"${w.title}" (${w.app})`).slice(0, 25).join(', ')
      );
    }
    const active = all.find((w) => w.active);
    if (!active) throw new Error('no active accessible window; pass `window` (title or app name)');
    return active;
  }

  async tree(opts: UiTreeOptions): Promise<UiTree> {
    const all = await this.windows();
    const win = this.pickWindow(all, opts.window);
    const { bus, path } = decodeHandle(win.handle);

    // Breadth-first fetch (each level in parallel), then re-order depth-first
    // for display. Hidden subtrees (not SHOWING) are skipped entirely.
    const nodes: Walked[] = [];
    let truncated = false;
    let level: Array<{ bus: string; path: string; parent: number }> = [{ bus, path, parent: -1 }];
    while (level.length > 0 && !truncated) {
      const room = opts.maxNodes - nodes.length;
      if (level.length > room) {
        level = level.slice(0, room);
        truncated = true;
      }
      const described = await Promise.all(level.map((n) => this.describe(n.bus, n.path).catch(() => null)));
      const next: Array<{ bus: string; path: string; parent: number }> = [];
      const expand: number[] = [];
      described.forEach((d, i) => {
        if (!d) return;
        const isRoot = level[i]!.parent === -1;
        if (!isRoot && isHidden(d)) return;
        // Scrolled-out subtrees (a long page's off-screen sections) are skipped
        // whole — both rects are in the app's own coordinate space.
        const rootBounds = nodes[0]?.bounds;
        if (!isRoot && !opts.includeOffscreen && rootBounds && d.bounds && !intersects(d.bounds, rootBounds)) return;
        const idx = nodes.push({ ...d, parent: level[i]!.parent, children: [] }) - 1;
        if (level[i]!.parent >= 0) nodes[level[i]!.parent]!.children.push(idx);
        // Firefox reports ChildCount 0 on documents whose children are
        // created lazily, so frames/documents are always asked.
        if (d.childCount > 0 || /^(frame|window|dialog|internal frame|document|embedded)/i.test(d.role)) {
          expand.push(idx);
        }
      });
      const kids = await Promise.all(
        expand.map((idx) => this.children(nodes[idx]!.bus, nodes[idx]!.path).catch(() => []))
      );
      expand.forEach((idx, k) => {
        const list = kids[k]!;
        if (list.length > MAX_CHILDREN_PER_NODE) truncated = true;
        for (const [cb, cp] of list.slice(0, MAX_CHILDREN_PER_NODE)) next.push({ bus: cb, path: cp, parent: idx });
      });
      level = next;
    }

    // Unnamed text carriers (paragraphs, static text, labels) hold their
    // words in the Text interface, not Name — pull them so the tree reads
    // like the page instead of a list of empty paragraphs.
    await Promise.all(nodes.map(async (n) => {
      if (n.name.trim() || !TEXTY_ROLE.test(n.role) || !n.ifaces.includes('org.a11y.atspi.Text')) return;
      const text = await this.q<string>(n.bus, n.path, 'org.a11y.atspi.Text', 'GetText', 'ii', [0, -1]).catch(() => '');
      n.name = String(text ?? '').replace(/\uFFFC/g, ' ');
    }));

    const query = opts.query?.toLowerCase();
    const kept: Array<{ n: Walked; depth: number }> = [];
    const visit = (idx: number, depth: number): void => {
      const n = nodes[idx]!;
      const named = n.name.trim().length > 0;
      const interactive = isInteractiveRole(n.role);
      let keep = idx === 0 || named || interactive;
      if (query && idx !== 0) {
        keep = `${n.role} ${n.name}`.toLowerCase().includes(query) && (named || interactive);
      }
      if (keep) kept.push({ n, depth });
      const childDepth = keep && !query ? depth + 1 : depth;
      for (const c of n.children) visit(c, childDepth);
    };
    if (nodes.length > 0) visit(0, 0);

    const out: UiNode[] = await Promise.all(kept.map(async ({ n, depth }) => ({
      handle: encodeHandle(n.bus, n.path),
      depth,
      role: n.role,
      name: clip(n.name),
      value: await this.valueOf(n).catch(() => undefined),
      states: stateWords(n.states),
      bounds: n.bounds,
      actions: (await this.actionNames(n.bus, n.path, n.ifaces).catch(() => [])).filter(Boolean),
    })));

    const wayland = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland';
    const notes: string[] = [];
    if (this.justEnabled) {
      notes.push('Accessibility was just switched on; apps that were already running may take a second to export their trees, and Chromium/Electron apps usually need a restart (or --force-renderer-accessibility).');
    }
    if (wayland) {
      notes.push('Wayland: native apps cannot see their own screen position, so element bounds may be window-relative. Prefer ui_act press/set_text/focus over pointer clicks.');
    }
    return { window: win, nodes: out, truncated, boundsReliable: !wayland, notes };
  }

  private async valueOf(n: Described): Promise<string | undefined> {
    if (n.ifaces.includes('org.a11y.atspi.Value')) {
      const v = await this.q(n.bus, n.path, PROPS, 'Get', 'ss', ['org.a11y.atspi.Value', 'CurrentValue']);
      const num = unwrap(v);
      if (num !== undefined && num !== null) return String(num);
    }
    // Only genuinely editable fields: Firefox puts EditableText on frames and
    // tabs too, whose "text" is a run of object-replacement characters.
    if (hasState(n.states, S.EDITABLE) && n.ifaces.includes('org.a11y.atspi.Text')) {
      const text = await this.q<string>(n.bus, n.path, 'org.a11y.atspi.Text', 'GetText', 'ii', [0, -1]);
      return clip(String(text ?? '').replace(/\uFFFC/g, ''));
    }
    return undefined;
  }

  private async boundsOf(bus: string, path: string, ifaces: string[]): Promise<Rect | undefined> {
    if (!ifaces.includes('org.a11y.atspi.Component')) return undefined;
    const ext = await this.q<[number, number, number, number]>(
      bus, path, 'org.a11y.atspi.Component', 'GetExtents', 'u', [0 /* ATSPI_COORD_TYPE_SCREEN */]
    );
    const [x, y, w, h] = (ext ?? []).map(Number);
    if (w === undefined || h === undefined || x === undefined || y === undefined || w <= 0 || h <= 0) return undefined;
    return { x, y, w, h };
  }

  private async actionNames(bus: string, path: string, ifaces: string[]): Promise<string[]> {
    if (!ifaces.includes('org.a11y.atspi.Action')) return [];
    // NActions + GetName(i) rather than GetActions: Firefox returns garbage
    // (";;") from GetActions but answers the per-index calls correctly.
    const n = Number(unwrap(await this.q(bus, path, PROPS, 'Get', 'ss', ['org.a11y.atspi.Action', 'NActions'])) ?? 0);
    const names = await Promise.all(
      Array.from({ length: Math.min(n, 8) }, (_, i) =>
        this.q<string>(bus, path, 'org.a11y.atspi.Action', 'GetName', 'i', [i]).catch(() => '')
      )
    );
    return names.map((x) => String(x ?? ''));
  }

  async act(handle: string, op: UiOp, text?: string): Promise<UiActResult> {
    const { bus, path } = decodeHandle(handle);
    const ifaces = await this.q<string[]>(bus, path, ACC, 'GetInterfaces');

    if (op === 'set_text') {
      if (text === undefined) throw new Error('set_text needs `text`');
      if (ifaces.includes('org.a11y.atspi.EditableText')) {
        const ok = await this.q<boolean>(bus, path, 'org.a11y.atspi.EditableText', 'SetTextContents', 's', [text]);
        if (ok) return { method: 'set-text' };
      }
      // No editable-text API: focus it and let the caller type.
      await this.act(handle, 'focus');
      return { method: 'focus-then-type' };
    }

    if (op === 'focus') {
      if (ifaces.includes('org.a11y.atspi.Component')) {
        const ok = await this.q<boolean>(bus, path, 'org.a11y.atspi.Component', 'GrabFocus');
        if (ok) return { method: 'grab-focus' };
      }
      return this.pointerFallback(bus, path, ifaces, 'focus');
    }

    if (op === 'press' && ifaces.includes('org.a11y.atspi.Action')) {
      const names = (await this.actionNames(bus, path, ifaces)).map((n) => n.toLowerCase());
      let i = -1;
      for (const want of PRESS_ACTIONS) {
        i = names.indexOf(want);
        if (i >= 0) break;
      }
      if (i < 0 && names.length > 0) i = 0;
      if (i >= 0) {
        const ok = await this.q<boolean>(bus, path, 'org.a11y.atspi.Action', 'DoAction', 'i', [i]);
        if (ok !== false) return { method: `action:${names[i]}` };
      }
    }

    return this.pointerFallback(bus, path, ifaces, op);
  }

  private async pointerFallback(bus: string, path: string, ifaces: string[], op: string): Promise<UiActResult> {
    const b = await this.boundsOf(bus, path, ifaces);
    if (!b) throw new Error(`element supports no ${op} action and reports no on-screen bounds`);
    return { method: 'pointer-click', pointer: { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } };
  }
}

// ---------------------------------------------------------------------------
// Real bus wiring
// ---------------------------------------------------------------------------

let busPromise: Promise<MessageBus> | null = null;

async function a11yBus(): Promise<MessageBus> {
  if (!busPromise) {
    busPromise = (async () => {
      const session = dbus.sessionBus();
      try {
        const obj = await session.getProxyObject('org.a11y.Bus', '/org/a11y/bus');
        const address = await (obj.getInterface('org.a11y.Bus') as unknown as { GetAddress(): Promise<string> }).GetAddress();
        return dbus.sessionBus({ busAddress: address });
      } finally {
        session.disconnect();
      }
    })();
    busPromise.catch(() => { busPromise = null; });
  }
  return busPromise;
}

const realCall: DbusCall = async (dest, path, iface, member, signature = '', body = []) => {
  const bus = await a11yBus();
  const reply = await bus.call(new Message({ destination: dest, path, interface: iface, member, signature, body }));
  return reply?.body ?? [];
};

/** Turn on org.a11y.Status.IsEnabled. Returns true when it was off (i.e. we just enabled it). */
async function ensureEnabled(): Promise<boolean> {
  const session = dbus.sessionBus();
  try {
    const obj = await session.getProxyObject('org.a11y.Bus', '/org/a11y/bus');
    const props = obj.getInterface(PROPS) as unknown as {
      Get(i: string, p: string): Promise<{ value: unknown }>;
      Set(i: string, p: string, v: Variant): Promise<void>;
    };
    const cur = await props.Get('org.a11y.Status', 'IsEnabled');
    if (cur.value === true) return false;
    await props.Set('org.a11y.Status', 'IsEnabled', new Variant('b', true));
    // Give running toolkits a moment to register on the a11y bus.
    await new Promise((r) => setTimeout(r, 1_500));
    return true;
  } finally {
    session.disconnect();
  }
}

export function createAtspiBackend(): A11yBackend {
  return new AtspiBackend(realCall, ensureEnabled);
}
