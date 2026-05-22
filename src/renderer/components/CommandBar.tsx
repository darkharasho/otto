import { useRef, useState, type FormEvent, useEffect } from 'react';

interface Props {
  onSubmit(text: string): void;
  autoFocus?: boolean;
  busy?: boolean;
}

export function CommandBar({ onSubmit, autoFocus = true, busy = false }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface border border-border shadow-2xl"
    >
      <span className="text-muted text-sm select-none">⌘</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ask Otto to do something…"
        disabled={busy}
        className="flex-1 bg-transparent outline-none text-text placeholder:text-muted text-base"
      />
      <kbd className="text-xs text-muted border border-border rounded px-1.5 py-0.5">↵</kbd>
    </form>
  );
}
