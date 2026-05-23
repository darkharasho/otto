import { useRef, useState, type FormEvent, useEffect } from 'react';
import { OttoMark } from './OttoMark';

interface Props {
  onSubmit(text: string): void;
  autoFocus?: boolean;
  busy?: boolean;
}

export function CommandBar({ onSubmit, autoFocus = true, busy = false }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && !busy) inputRef.current?.focus();
  }, [autoFocus, busy]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  const placeholder = busy ? 'Otto is working…' : 'Ask Otto to do something…';
  const canSend = !busy && value.trim().length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={busy}
      className={[
        'relative flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-2xl transition-colors',
        'focus-within:border-accent/70',
        busy
          ? 'bg-surface/80 border-accent/60 ring-1 ring-accent/40'
          : 'bg-surface border-border',
      ].join(' ')}
    >
      <span
        className={[
          'flex items-center justify-center w-5 h-5 shrink-0',
          busy ? 'text-accent animate-pulse' : 'text-muted',
        ].join(' ')}
      >
        <OttoMark className="w-5 h-5" />
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
        aria-disabled={busy}
        className={[
          'flex-1 bg-transparent outline-none text-base placeholder:text-muted',
          busy ? 'text-muted cursor-not-allowed' : 'text-text',
        ].join(' ')}
      />
      <div className="flex items-center justify-end h-6 shrink-0">
        {busy ? (
          <span className="flex items-center gap-2 text-xs text-accent font-medium">
            <span className="flex gap-1" aria-hidden>
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" />
            </span>
            <span>thinking</span>
          </span>
        ) : canSend ? (
          <button
            type="submit"
            aria-label="Send"
            className="flex items-center justify-center w-6 h-6 rounded-md bg-accent/90 hover:bg-accent text-white shadow transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        ) : (
          <kbd className="text-xs text-muted border border-border rounded px-1.5 py-0.5">↵</kbd>
        )}
      </div>
      {busy && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-2xl"
        >
          <span className="block h-full w-1/3 bg-accent/70 animate-[shimmer_1.4s_ease-in-out_infinite]" />
        </span>
      )}
    </form>
  );
}
