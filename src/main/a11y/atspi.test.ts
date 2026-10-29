import { describe, it, expect, vi } from 'vitest';
import { AtspiBackend, decodeHandle, encodeHandle, isHidden, stateWords, type DbusCall } from './atspi';

// State bit helpers (AtspiStateType indices).
const SHOWING = 1 << 25;
const VISIBLE = 1 << 30;
const FOCUSED = 1 << 12;
const ENABLED = 1 << 8;
const EDITABLE = 1 << 7;
const ACTIVE = 1 << 1;
const ON = SHOWING | VISIBLE | ENABLED;

interface FakeNode {
  role: string;
  name?: string;
  states?: number;
  ifaces?: string[];
  extents?: [number, number, number, number];
  actions?: string[];
  text?: string;
  children?: string[];
}

const BUS = ':1.42';

/** In-memory AT-SPI app: path → node. Registry root lists one app. */
function fakeBus(nodes: Record<string, FakeNode>, appName = 'demo') {
  const calls: string[] = [];
  const call: DbusCall = async (dest, path, iface, member, _sig, body = []) => {
    calls.push(`${member} ${path}`);
    if (dest === 'org.a11y.atspi.Registry') {
      if (member === 'GetChildren') return [[[BUS, '/app']]];
    }
    if (path === '/app') {
      if (member === 'GetAll') return [{ Name: { signature: 's', value: appName }, ChildCount: { signature: 'i', value: 1 } }];
      if (member === 'GetChildren') return [[[BUS, '/win']]];
    }
    const n = nodes[path];
    if (!n) throw new Error(`no node ${path}`);
    switch (member) {
      case 'GetAll':
        return [{ Name: { signature: 's', value: n.name ?? '' }, ChildCount: { signature: 'i', value: n.children?.length ?? 0 } }];
      case 'GetRoleName': return [n.role];
      case 'GetState': return [[n.states ?? ON, 0]];
      case 'GetInterfaces': return [['org.a11y.atspi.Accessible', ...(n.ifaces ?? [])]];
      case 'GetChildren': return [(n.children ?? []).map((c) => [BUS, c])];
      case 'GetExtents': return [n.extents ?? [0, 0, 0, 0]];
      case 'Get':
        if (body[1] === 'NActions') return [{ signature: 'i', value: n.actions?.length ?? 0 }];
        return [{ signature: 'd', value: 0 }];
      case 'GetName': return [n.actions?.[body[0] as number] ?? ''];
      case 'GetText': return [n.text ?? ''];
      case 'DoAction': return [true];
      case 'SetTextContents': return [true];
      case 'GrabFocus': return [true];
      default: throw new Error(`unexpected ${iface}.${member}`);
    }
  };
  return { call, calls };
}

const C = 'org.a11y.atspi.Component';
const A = 'org.a11y.atspi.Action';
const T = 'org.a11y.atspi.Text';
const E = 'org.a11y.atspi.EditableText';

function sampleTree(): Record<string, FakeNode> {
  return {
    '/win': { role: 'frame', name: 'Settings', states: ON | ACTIVE, ifaces: [C], extents: [0, 0, 800, 600], children: ['/box', '/hidden', '/far', '/tab'] },
    '/box': { role: 'panel', ifaces: [C], extents: [0, 0, 800, 100], children: ['/ok', '/field', '/para'] },
    '/ok': { role: 'push button', name: 'OK', ifaces: [C, A], extents: [700, 20, 80, 30], actions: ['press'] },
    '/field': { role: 'entry', name: 'Name', states: ON | EDITABLE | FOCUSED, ifaces: [C, T, E], extents: [10, 20, 200, 30], text: 'Otto' },
    '/para': { role: 'paragraph', ifaces: [C, T], extents: [10, 60, 300, 20], text: 'Hello￼world' },
    '/hidden': { role: 'push button', name: 'Ghost', states: ENABLED, ifaces: [C, A], children: ['/ghostkid'] },
    '/ghostkid': { role: 'push button', name: 'Never', ifaces: [C] },
    '/far': { role: 'section', ifaces: [C], extents: [0, 5000, 800, 100], children: ['/farbtn'] },
    '/farbtn': { role: 'push button', name: 'Offscreen', ifaces: [C, A], extents: [0, 5000, 50, 20] },
    // A background tab's document: visible but not showing → pruned with its subtree.
    '/tab': { role: 'internal frame', states: VISIBLE | ENABLED, ifaces: [C], extents: [0, 0, 800, 600], children: ['/tabbtn'] },
    '/tabbtn': { role: 'push button', name: 'Background', ifaces: [C] },
  };
}

describe('handles and states', () => {
  it('round-trips bus + path', () => {
    expect(decodeHandle(encodeHandle(':1.5', '/a/b'))).toEqual({ bus: ':1.5', path: '/a/b' });
    expect(() => decodeHandle('nope')).toThrow();
  });

  it('reports interesting states, including disabled', () => {
    expect(stateWords([FOCUSED | EDITABLE | ENABLED, 0])).toEqual(['focused', 'editable']);
    expect(stateWords([0, 0])).toEqual(['disabled']);
  });

  it('prunes non-visible nodes and non-showing documents/frames', () => {
    expect(isHidden({ role: 'push button', states: [ENABLED, 0] })).toBe(true);
    expect(isHidden({ role: 'push button', states: [VISIBLE, 0] })).toBe(false);
    expect(isHidden({ role: 'internal frame', states: [VISIBLE, 0] })).toBe(true);
    expect(isHidden({ role: 'document web', states: [VISIBLE | SHOWING, 0] })).toBe(false);
  });
});

describe('AtspiBackend.tree', () => {
  it('walks the active window, keeping named/interactive nodes in document order', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const tree = await be.tree({ maxNodes: 100 });
    expect(tree.window.title).toBe('Settings');
    expect(tree.nodes.map((n) => n.name)).toEqual(['Settings', 'OK', 'Name', 'Hello world']);
  });

  it('skips hidden, scrolled-off and background-tab subtrees', async () => {
    const { call, calls } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const names = (await be.tree({ maxNodes: 100 })).nodes.map((n) => n.name);
    expect(names).not.toContain('Ghost');
    expect(names).not.toContain('Offscreen');
    expect(names).not.toContain('Background');
    // Pruned subtrees are never even fetched.
    expect(calls.some((c) => c.endsWith('/ghostkid'))).toBe(false);
    expect(calls.some((c) => c.endsWith('/farbtn'))).toBe(false);
  });

  it('includes scrolled-off elements on request', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const names = (await be.tree({ maxNodes: 100, includeOffscreen: true })).nodes.map((n) => n.name);
    expect(names).toContain('Offscreen');
  });

  it('carries value, states, bounds and action names', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const nodes = (await be.tree({ maxNodes: 100 })).nodes;
    const field = nodes.find((n) => n.name === 'Name')!;
    expect(field.value).toBe('Otto');
    expect(field.states).toEqual(['focused', 'editable']);
    const ok = nodes.find((n) => n.name === 'OK')!;
    expect(ok.bounds).toEqual({ x: 700, y: 20, w: 80, h: 30 });
    expect(ok.actions).toEqual(['press']);
  });

  it('filters by query and flattens depth', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const nodes = (await be.tree({ maxNodes: 100, query: 'ok' })).nodes;
    expect(nodes.map((n) => [n.name, n.depth])).toEqual([['Settings', 0], ['OK', 0]]);
  });

  it('marks the tree truncated when maxNodes runs out', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    const tree = await be.tree({ maxNodes: 2 });
    expect(tree.truncated).toBe(true);
  });

  it('picks a window by title/app substring and lists alternatives on a miss', async () => {
    const { call } = fakeBus(sampleTree(), 'kcalc');
    const be = new AtspiBackend(call, async () => false);
    expect((await be.tree({ window: 'KCALC', maxNodes: 10 })).window.title).toBe('Settings');
    await expect(be.tree({ window: 'firefox', maxNodes: 10 })).rejects.toThrow(/"Settings" \(kcalc\)/);
  });

  it('turns accessibility on once and notes it', async () => {
    const { call } = fakeBus(sampleTree());
    const enable = vi.fn(async () => true);
    const be = new AtspiBackend(call, enable);
    const first = await be.tree({ maxNodes: 10 });
    expect(first.notes.join(' ')).toMatch(/just switched on/);
    const second = await be.tree({ maxNodes: 10 });
    expect(second.notes.join(' ')).not.toMatch(/just switched on/);
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe('AtspiBackend.act', () => {
  it('presses through the Action interface', async () => {
    const { call, calls } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    expect(await be.act(encodeHandle(BUS, '/ok'), 'press')).toEqual({ method: 'action:press' });
    expect(calls).toContain('DoAction /ok');
  });

  it('sets text through EditableText', async () => {
    const { call, calls } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    expect(await be.act(encodeHandle(BUS, '/field'), 'set_text', 'Bob')).toEqual({ method: 'set-text' });
    expect(calls).toContain('SetTextContents /field');
  });

  it('falls back to a pointer click at the element center', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    expect(await be.act(encodeHandle(BUS, '/para'), 'press')).toEqual({
      method: 'pointer-click',
      pointer: { x: 160, y: 70 },
    });
  });

  it('asks the caller to type when there is no editable-text API', async () => {
    const { call } = fakeBus(sampleTree());
    const be = new AtspiBackend(call, async () => false);
    expect(await be.act(encodeHandle(BUS, '/para'), 'set_text', 'x')).toEqual({ method: 'focus-then-type' });
  });
});
