import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'keypress' }>;

const GLYPH: Record<string, string> = {
  cmd: '⌘', command: '⌘', meta: '⌘',
  ctrl: '⌃', control: '⌃',
  alt: '⌥', option: '⌥',
  shift: '⇧',
  enter: '↵', return: '↵',
  esc: 'Esc', escape: 'Esc',
  tab: '⇥', space: '␣',
  backspace: '⌫', delete: '⌦',
  up: '↑', down: '↓', left: '←', right: '→',
};

function render(k: string): string {
  const lc = k.toLowerCase();
  return GLYPH[lc] ?? (k.length === 1 ? k.toUpperCase() : k);
}

export function KeyCapsCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {view.keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted text-[10px]">+</span>}
          <kbd className="px-1.5 py-0.5 rounded border border-border border-b-2 bg-surface/60 font-mono text-[11px]">
            {render(k)}
          </kbd>
        </span>
      ))}
    </div>
  );
}
