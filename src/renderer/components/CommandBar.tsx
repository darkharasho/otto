import { useRef, useState, type FormEvent, useEffect } from 'react';
import { OttoMark } from './OttoMark';
import { ipc } from '../ipc';

interface Props {
  onSubmit(text: string): void;
  onStop?(): void;
  autoFocus?: boolean;
  busy?: boolean;
  welcome?: boolean;
}

export function CommandBar({
  onSubmit,
  onStop,
  autoFocus = true,
  busy = false,
  welcome = false,
}: Props) {
  const [value, setValue] = useState('');
  const [sendTick, setSendTick] = useState(0);
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    // Guarded so tests that don't mount the preload bridge don't blow up.
    if (typeof window === 'undefined' || !window.otto) return;
    void ipc.invoke('app.info', undefined).then((info) => setIsDev(info.isDev)).catch(() => {});
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (autoFocus && !busy) inputRef.current?.focus();
  }, [autoFocus, busy]);

  // Replay the send-bounce animation by toggling the class on each submit.
  useEffect(() => {
    if (sendTick === 0 || !formRef.current) return;
    const el = formRef.current;
    el.classList.remove('otto-send-bounce');
    // force reflow so the next add restarts the animation
    void el.offsetWidth;
    el.classList.add('otto-send-bounce');
  }, [sendTick]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
    setSendTick((n) => n + 1);
  }

  const placeholder = busy ? 'Otto is working…' : 'Ask Otto to do something…';
  const canSend = !busy && value.trim().length > 0;

  return (
    <form
      ref={formRef}
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
          'relative flex items-center justify-center w-5 h-5 shrink-0',
          busy ? 'text-accent animate-pulse' : welcome ? 'text-accent' : 'text-muted',
        ].join(' ')}
      >
        {welcome && !busy && value.length === 0 && <span aria-hidden className="otto-halo" />}
        <OttoMark className="relative w-5 h-5" />
      </span>
      {isDev && (
        <span
          title="Development build"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-400 border border-amber-500/40"
        >
          dev
        </span>
      )}
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
          <button
            type="button"
            onClick={onStop}
            disabled={!onStop}
            aria-label="Stop response"
            title="Stop response (Esc)"
            className="group flex items-center gap-2 text-xs text-accent font-medium hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="flex items-center justify-center w-6 h-6 rounded-md bg-accent/15 group-hover:bg-accent text-accent group-hover:text-white transition-colors">
              <span className="w-2.5 h-2.5 rounded-[2px] bg-current" aria-hidden />
            </span>
            <span className="group-hover:text-text">stop</span>
          </button>
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
