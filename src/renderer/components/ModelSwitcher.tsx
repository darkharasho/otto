import { useEffect, useRef, useState } from 'react';

export interface ModelOption {
  id: string;
  label: string;
  family: 'opus' | 'sonnet' | 'haiku';
  tagline: string;
}

const MODELS: ModelOption[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    family: 'opus',
    tagline: 'Highest reasoning, slowest',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    family: 'sonnet',
    tagline: 'Balanced — good default',
  },
  {
    id: 'claude-haiku-4-5-20251001',
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

export function ModelSwitcher({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.id === value);
  const displayLabel = current?.label ?? value;

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
          'flex items-center gap-1.5 px-1.5 py-0.5 rounded border text-[10px] transition-colors',
          'bg-bg/60 border-border hover:border-accent/60 hover:text-text',
          disabled ? 'opacity-60 cursor-not-allowed' : '',
        ].join(' ')}
        title="Model for new sessions"
      >
        <span className="font-medium">{displayLabel}</span>
        <svg
          viewBox="0 0 24 24"
          className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="otto-dropdown-enter absolute left-0 top-full mt-1.5 w-64 rounded-xl border border-border bg-surface shadow-2xl z-10 p-1"
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
                  'relative w-full text-left pl-3 pr-2.5 py-2 rounded-lg transition-colors',
                  active ? 'bg-accent/10 text-text' : 'text-text hover:bg-bg/60',
                ].join(' ')}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{m.label}</span>
                  <span
                    className={[
                      'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                      m.family === 'opus' && 'bg-accent/20 text-accent',
                      m.family === 'sonnet' && 'bg-text/10 text-text',
                      m.family === 'haiku' && 'bg-bg/80 text-muted',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {m.family}
                  </span>
                </div>
                <div className="text-[11px] text-muted mt-0.5">{m.tagline}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
