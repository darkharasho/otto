/**
 * Accessibility-tree access: lets the agent read a window's controls as text
 * (role, name, state, bounds) and operate them by id instead of estimating
 * pixel coordinates from screenshots. Each OS has its own backend (AT-SPI on
 * Linux, UI Automation on Windows, AX via System Events on macOS); this file
 * is the shared vocabulary.
 */

export interface Rect { x: number; y: number; w: number; h: number; }

export interface UiNode {
  /** Backend-specific handle, opaque to callers (resolved by the same backend). */
  handle: string;
  depth: number;
  role: string;
  name: string;
  /** Current value for inputs/sliders/combos, or text content for editable fields. */
  value?: string;
  /** Interesting states only: focused, checked, selected, disabled, expanded, collapsed, editable, … */
  states: string[];
  /** Screen rect in virtual-desktop pixels, when the backend can report one. */
  bounds?: Rect;
  /** Named actions the element supports (press, toggle, …). */
  actions: string[];
}

export interface UiWindowInfo {
  handle: string;
  app: string;
  title: string;
  active: boolean;
}

export interface UiTreeOptions {
  /** Case-insensitive substring of the window title or app name. Omitted = the active window. */
  window?: string;
  /** Only keep nodes whose name/role/value contains this (case-insensitive). Ancestors are dropped. */
  query?: string;
  /** Upper bound on nodes visited. */
  maxNodes: number;
  /** Also include elements scrolled out of view (still laid out, just not on screen). */
  includeOffscreen?: boolean;
}

export interface UiTree {
  window: UiWindowInfo;
  nodes: UiNode[];
  /** True when maxNodes cut the walk short. */
  truncated: boolean;
  /** Whether `bounds` are trustworthy for pointer clicks (false on Wayland for native apps). */
  boundsReliable: boolean;
  notes: string[];
}

export type UiOp = 'press' | 'focus' | 'set_text' | 'click';

export interface UiActResult {
  /** How the op was carried out ('action:click', 'set-text', 'pointer-click', …). */
  method: string;
  /** Pointer target when the op fell back to (or asked for) a real click. */
  pointer?: { x: number; y: number };
}

export interface A11yBackend {
  readonly name: string;
  windows(): Promise<UiWindowInfo[]>;
  tree(opts: UiTreeOptions): Promise<UiTree>;
  /**
   * Operate an element. Backends try semantic APIs first (invoke/press, set
   * value, focus) and return `pointer` when only a coordinate click will do —
   * the caller performs that click through the input adapter.
   */
  act(handle: string, op: UiOp, text?: string): Promise<UiActResult>;
}

export const INTERACTIVE_ROLE_WORDS = [
  'button', 'check', 'radio', 'combo', 'entry', 'edit', 'text field', 'textfield', 'password',
  'link', 'menu', 'tab', 'list item', 'listitem', 'tree item', 'treeitem', 'slider', 'spin',
  'toggle', 'switch', 'option', 'cell', 'row', 'search', 'hyperlink', 'disclosure', 'incrementor',
];

export function isInteractiveRole(role: string): boolean {
  const r = role.toLowerCase();
  return INTERACTIVE_ROLE_WORDS.some((w) => r.includes(w));
}
