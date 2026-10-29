import { describe, it, expect } from 'vitest';
import { actScript, parseActOutput, parseTreeOutput, treeScript } from './uia';
import { actJxa, parseAxTree, treeJxa } from './ax';

const S = '\u001f';

describe('UI Automation (Windows)', () => {
  it('parses window, nodes and truncation from the PowerShell output', () => {
    const out = [
      `W${S}Untitled - Notepad${S}notepad${S}True`,
      `N${S}u1${S}0${S}Window${S}Untitled - Notepad${S}${S}${S}0,0,800,600${S}`,
      `N${S}u2${S}1${S}Button${S}Save${S}${S}disabled,focused${S}10,20,80,30${S}invoke`,
      `N${S}u3${S}1${S}Edit${S}Text editor${S}hello${S}editable${S}${S}set_value`,
      'T',
    ].join('\r\n');
    const tree = parseTreeOutput(out);
    expect(tree.window).toEqual({ handle: '', title: 'Untitled - Notepad', app: 'notepad', active: true });
    expect(tree.truncated).toBe(true);
    expect(tree.nodes[1]).toEqual({
      handle: 'u2', depth: 1, role: 'Button', name: 'Save', value: undefined,
      states: ['disabled', 'focused'], bounds: { x: 10, y: 20, w: 80, h: 30 }, actions: ['invoke'],
    });
    expect(tree.nodes[2]!.value).toBe('hello');
    expect(tree.nodes[2]!.bounds).toBeUndefined();
  });

  it('parses pointer fallbacks and plain methods from act output', () => {
    expect(parseActOutput(`pointer-click${S}120${S}340`)).toEqual({ method: 'pointer-click', pointer: { x: 120, y: 340 } });
    expect(parseActOutput('invoke\r\n')).toEqual({ method: 'invoke' });
  });

  it("single-quotes user strings so they can't break out of the script", () => {
    expect(treeScript({ window: "Bob's App", maxNodes: 50 })).toContain("$needle = 'bob''s app'");
    expect(actScript('u3', 'set_text', "it's")).toContain("$text = 'it''s'");
  });
});

describe('AX via System Events (macOS)', () => {
  const raw = {
    window: { pid: 501, index: 0, app: 'Finder', title: 'Downloads', active: true },
    nodes: [
      { handle: '501:0:', depth: 0, role: 'AXWindow', name: 'Downloads', value: '', states: [], bounds: null },
      { handle: '501:0:0', depth: 1, role: 'AXGroup', name: '', value: '', states: [], bounds: null },
      { handle: '501:0:0/1', depth: 2, role: 'AXButton', name: 'Back', value: '', states: ['disabled'], bounds: { x: 1, y: 2, w: 3, h: 4 } },
      { handle: '501:0:0/2', depth: 2, role: 'AXTextField', name: '', value: 'report', states: [], bounds: null },
    ],
    truncated: false,
  };

  it('strips the AX prefix and drops unnamed structural groups', () => {
    const tree = parseAxTree(JSON.stringify(raw));
    expect(tree.nodes.map((n) => n.role)).toEqual(['Window', 'Button', 'TextField']);
    expect(tree.nodes[1]!.bounds).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(tree.nodes[2]!.value).toBe('report');
  });

  it('applies the query filter', () => {
    expect(parseAxTree(JSON.stringify(raw), 'back').nodes.map((n) => n.name)).toEqual(['Downloads', 'Back']);
  });

  it('re-resolves an element from its index path', () => {
    expect(actJxa('501:0:0/1', 'press')).toContain('resolveWindow(501, 0).uiElements[0].uiElements[1]');
    expect(() => actJxa('garbage', 'press')).toThrow(/invalid element handle/);
  });

  it('embeds options as JSON', () => {
    expect(treeJxa({ window: 'Fi"nder', maxNodes: 9 })).toContain(JSON.stringify({ window: 'Fi"nder', maxNodes: 9 }));
  });
});
