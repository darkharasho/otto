import { useRef, useState, type FormEvent, useEffect } from 'react';
import { Paperclip, Lock } from 'lucide-react';
import { OttoMark } from './OttoMark';
import { ipc } from '../ipc';
import { extFromMime } from '@shared/messages';
import type { ContentBlock } from '@shared/messages';
import {
  parseNewConversationPrefix,
  NEW_CONVERSATION_PREFIX,
  parsePrivateConversationPrefix,
  PRIVATE_CONVERSATION_PREFIX,
} from '@shared/manual-prefix';

type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

interface Props {
  onSubmit(args: { text: string; attachments: ImageRef[] }): void;
  ensureSession(): Promise<string>;
  onStop?(): void;
  /** Called when Shift+Enter is pressed while busy — interrupts the current turn then sends. */
  onInterruptAndSend?(args: { text: string; attachments: ImageRef[] }): void;
  onNewConversation?(args: { text: string; attachments: ImageRef[] }): void;
  onPrivateConversation?(args: { text: string; attachments: ImageRef[] }): void;
  /** Show the private-conversation treatment (lock pill + violet accent). */
  isPrivate?: boolean;
  autoFocus?: boolean;
  busy?: boolean;
  queueDepth?: number;
  welcome?: boolean;
}

export function CommandBar({
  onSubmit,
  ensureSession,
  onStop,
  onInterruptAndSend,
  onNewConversation,
  onPrivateConversation,
  isPrivate = false,
  autoFocus = true,
  busy = false,
  queueDepth = 0,
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
    // Keep input focused when busy becomes true (user submitted while idle)
    // and restore focus when busy clears — so the user can keep typing.
    if (autoFocus) inputRef.current?.focus();
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Shift+Enter key-down semantics:
    //   !busy + Shift+Enter  → default: no-op on a single-line input (no newline to insert)
    //   busy  + Shift+Enter  → interrupt current turn and immediately send (preempt)
    //
    // Plain Enter is handled by the form's onSubmit; do not intercept it here.
    if (e.key === 'Enter' && e.shiftKey && busy) {
      e.preventDefault();
      const trimmed = value.trim();
      if ((trimmed.length > 0 || attachments.length > 0) && onInterruptAndSend) {
        onInterruptAndSend({ text: trimmed, attachments });
        setValue('');
        setAttachments([]);
        setSendTick((n) => n + 1);
        inputRef.current?.focus();
      }
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedNew = parseNewConversationPrefix(value);
    if (parsedNew && onNewConversation) {
      const remainder = parsedNew.remainder.trimEnd();
      onNewConversation({ text: remainder, attachments });
      setValue('');
      setAttachments([]);
      setSendTick((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    const parsedPrivate = parsePrivateConversationPrefix(value);
    if (parsedPrivate && onPrivateConversation) {
      const remainder = parsedPrivate.remainder.trimEnd();
      onPrivateConversation({ text: remainder, attachments });
      setValue('');
      setAttachments([]);
      setSendTick((n) => n + 1);
      inputRef.current?.focus();
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 && attachments.length === 0) return;
    onSubmit({ text: trimmed, attachments });
    setValue('');
    setAttachments([]);
    setSendTick((n) => n + 1);
    // Keep the input focused so the user can immediately type a follow-up.
    inputRef.current?.focus();
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

  const placeholder = busy
    ? 'Otto is working — your message will queue'
    : isPrivate
      ? 'Private — nothing here is saved, learned, or remembered'
      : 'Ask Otto to do something…';
  const canSend = value.trim().length > 0 || attachments.length > 0;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-busy={busy}
      data-private={isPrivate || undefined}
      className={[
        'relative flex items-center gap-3 px-4 py-3 rounded-[14px] transition-colors',
        isPrivate ? 'focus-within:border-[#7c7dff]/70' : 'focus-within:border-accent/70',
        busy
          ? 'otto-elevated border-accent/60 ring-1 ring-accent/40'
          : isPrivate
            ? 'otto-elevated border-[#7c7dff]/60 ring-1 ring-[#7c7dff]/30'
            : 'otto-elevated',
      ].join(' ')}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span
          className={[
            'relative flex items-center justify-center w-5 h-5 shrink-0',
            busy
              ? 'text-accent animate-pulse'
              : isPrivate
                ? 'text-[#7c7dff]'
                : welcome
                  ? 'text-accent'
                  : 'text-muted otto-mark-halo',
          ].join(' ')}
        >
          {welcome && !busy && !isPrivate && value.length === 0 && <span aria-hidden className="otto-halo" />}
          <OttoMark className="relative w-5 h-5" />
        </span>
        {isPrivate && (
          <span
            data-testid="private-indicator"
            title="Private conversation — nothing here is saved to history, learned, or written to memory"
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-[#7c7dff]/15 text-[#b9b9ff] border border-[#7c7dff]/40"
          >
            <Lock className="h-3 w-3" aria-hidden />
            private
          </span>
        )}
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
          onChange={(e) => {
            const next = e.target.value;
            // Typing the prefix triggers a new conversation immediately —
            // don't wait for Enter. Without this, the user keeps typing into
            // what visually still looks like the previous conversation.
            if (next === NEW_CONVERSATION_PREFIX && onNewConversation) {
              setValue('');
              setAttachments([]);
              onNewConversation({ text: '', attachments });
              return;
            }
            if (next === PRIVATE_CONVERSATION_PREFIX && onPrivateConversation) {
              setValue('');
              setAttachments([]);
              onPrivateConversation({ text: '', attachments });
              return;
            }
            setValue(next);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 bg-transparent outline-none text-base placeholder:text-muted text-text"
        />
      </div>
      {/* Inline attachment chips — between input and action buttons */}
      {attachments.length > 0 && (
        <>
          <div className="w-px h-5 bg-border shrink-0" aria-hidden />
          <div className="flex gap-1 flex-wrap shrink-0">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-1 px-1.5 py-0.5 bg-bg/60 rounded text-[10px]"
              >
                <img
                  src={`otto-user-image://${a.sessionId}/${a.id}.${extFromMime(a.mimeType)}`}
                  alt=""
                  className="h-5 w-5 object-cover rounded"
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
        </>
      )}
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
      {/* Queue depth chip */}
      {queueDepth > 0 && (
        <span aria-live="polite" className="shrink-0 text-xs text-muted">
          {queueDepth} queued
        </span>
      )}
      {/* Attach button */}
      {!busy && (
        <button
          type="button"
          aria-label="Attach image"
          title="Attach image"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 flex items-center justify-center w-6 h-6 text-muted hover:text-text transition-colors"
        >
          <Paperclip className="h-4 w-4" />
        </button>
      )}
      <div className="flex items-center justify-end h-6 shrink-0">
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            disabled={!onStop}
            aria-label="Stop response"
            title="Stop response (Esc) · Shift+Enter to interrupt and send new message"
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
            className="otto-send flex items-center justify-center w-6 h-6 rounded-md hover:brightness-110 transition"
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
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-[14px]"
        >
          <span className="block h-full w-1/3 bg-accent/70 animate-[shimmer_1.4s_ease-in-out_infinite]" />
        </span>
      )}
    </form>
  );
}
