import { useRef, useState, type FormEvent, useEffect } from 'react';
import { OttoMark } from './OttoMark';
import { ipc } from '../ipc';
import { extFromMime } from '@shared/messages';
import type { ContentBlock } from '@shared/messages';

type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

interface Props {
  onSubmit(args: { text: string; attachments: ImageRef[] }): void;
  ensureSession(): Promise<string>;
  onStop?(): void;
  autoFocus?: boolean;
  busy?: boolean;
  welcome?: boolean;
}

export function CommandBar({
  onSubmit,
  ensureSession,
  onStop,
  autoFocus = true,
  busy = false,
  welcome = false,
}: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ImageRef[]>([]);
  const [sendTick, setSendTick] = useState(0);
  const [isDev, setIsDev] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Guarded so tests that don't mount the preload bridge don't blow up.
    if (typeof window === 'undefined' || !window.otto) return;
    void ipc.invoke('app.info', undefined).then((info) => setIsDev(info.isDev)).catch(() => {});
  }, []);

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

  const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
  type AllowedMime = (typeof ALLOWED_MIME)[number];

  async function stageFile(file: File) {
    if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) return;
    const sessionId = await ensureSession();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await window.otto.invoke('uploads.stage', {
      sessionId,
      bytes,
      mimeType: file.type as AllowedMime,
    });
    setAttachments((a) => [...a, ref]);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && attachments.length === 0) return;
    onSubmit({ text: trimmed, attachments });
    setValue('');
    setAttachments([]);
    setSendTick((n) => n + 1);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLFormElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    let found = false;
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          found = true;
          void stageFile(file);
        }
      }
    }
    if (found) e.preventDefault();
  }

  function handleDragOver(e: React.DragEvent<HTMLFormElement>) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent<HTMLFormElement>) {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) {
        void stageFile(file);
      }
    }
  }

  const placeholder = busy ? 'Otto is working…' : 'Ask Otto to do something…';
  const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-busy={busy}
      className={[
        'relative flex flex-col px-4 py-3 rounded-2xl border shadow-2xl transition-colors',
        'focus-within:border-accent/70',
        busy
          ? 'bg-surface/80 border-accent/60 ring-1 ring-accent/40'
          : 'bg-surface border-border',
      ].join(' ')}
    >
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex gap-1 flex-wrap mb-1">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1 px-1.5 py-0.5 bg-bg/60 rounded text-[10px]"
            >
              <img
                src={`otto-user-image://${a.sessionId}/${a.id}.${extFromMime(a.mimeType)}`}
                alt=""
                className="h-4 w-4 object-cover rounded"
              />
              <button
                type="button"
                onClick={() => {
                  void window.otto.invoke('uploads.discard', { path: a.path, sessionId: a.sessionId });
                  setAttachments((s) => s.filter((x) => x.id !== a.id));
                }}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-center gap-3">
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
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            for (const f of Array.from(e.target.files ?? [])) void stageFile(f);
            e.target.value = '';
          }}
        />
        {/* Attach button */}
        {!busy && (
          <button
            type="button"
            aria-label="Attach image"
            title="Attach image"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 flex items-center justify-center w-6 h-6 text-muted hover:text-text transition-colors"
          >
            📎
          </button>
        )}
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
