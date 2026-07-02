import { useEffect, useRef, useState } from 'react';

export interface ModelOption {
  id: string;
  label: string;
  family: 'fable' | 'opus' | 'sonnet' | 'haiku';
  tagline: string;
}

const MODELS: ModelOption[] = [
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    family: 'fable',
    tagline: 'Most capable, slowest',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    family: 'opus',
    tagline: 'Highest reasoning',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    family: 'sonnet',
    tagline: 'Balanced — good default',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    family: 'haiku',
    tagline: 'Fastest, smallest',
  },
];

interface Props {
  value: string;
  onChange(id: string): void;
  disabled?: boolean;
}

function FamilyPill({ family }: { family: ModelOption['family'] }) {
  const cls =
    family === 'fable'
      ? 'bg-accent/30 text-accent'
      : family === 'opus'
        ? 'bg-accent/20 text-accent'
        : family === 'sonnet'
          ? 'bg-text/10 text-text'
          : 'bg-bg/80 text-muted';
  return (
    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${cls}`}>
      {family}
    </span>
  );
}

function ModelGlyph({ family }: { family: ModelOption['family'] }) {
  // Filled dots map to capability: one (haiku), two (sonnet), three (opus),
  // four (fable).
  const filled = family === 'fable' ? 4 : family === 'opus' ? 3 : family === 'sonnet' ? 2 : 1;
  return (
    <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-accent/10 text-accent">
      <span className="flex gap-[3px]" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={[
              'w-1.5 h-1.5 rounded-full transition-opacity',
              i < filled ? 'bg-accent opacity-100' : 'bg-accent opacity-25',
            ].join(' ')}
          />
        ))}
      </span>
    </span>
  );
}

export function ModelSwitcher({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.id === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={[
          'group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors text-left',
          'bg-bg/40 border-border hover:border-accent/60 focus:border-accent/70 focus:outline-none',
          open ? 'border-accent/70' : '',
          disabled ? 'opacity-60 cursor-not-allowed' : '',
        ].join(' ')}
      >
        {current ? <ModelGlyph family={current.family} /> : null}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text truncate">
              {current?.label ?? value}
            </span>
            {current && <FamilyPill family={current.family} />}
          </div>
          {current && (
            <div className="text-[11px] text-muted mt-0.5 truncate">{current.tagline}</div>
          )}
        </div>
        <svg
          viewBox="0 0 24 24"
          className={`w-4 h-4 text-muted transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="otto-dropdown-enter absolute left-0 right-0 top-full mt-2 rounded-xl border border-border bg-surface shadow-2xl z-10 p-1.5"
        >
          {MODELS.map((m) => {
            const active = m.id === value;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={[
                  'relative w-full flex items-center gap-3 text-left px-2.5 py-2.5 rounded-lg transition-colors',
                  active ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg/60',
                ].join(' ')}
              >
                {active && (
                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" />
                )}
                <ModelGlyph family={m.family} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{m.label}</span>
                    <FamilyPill family={m.family} />
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">{m.tagline}</div>
                </div>
                {active && (
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 text-accent flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
