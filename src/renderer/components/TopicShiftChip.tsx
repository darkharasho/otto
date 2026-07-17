import { useEffect, useRef } from 'react';

interface Props {
  onStartNew(): void;
  onKeepGoing(): void;
}

export function TopicShiftChip({ onStartNew, onKeepGoing }: Props) {
  const startNewRef = useRef<HTMLButtonElement>(null);
  const keepGoingRef = useRef<HTMLButtonElement>(null);

  // Focus the safe action on mount so a stray Enter keeps the conversation
  // going rather than tearing it down.
  useEffect(() => {
    keepGoingRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd/Ctrl+Enter always starts a new conversation, regardless of focus.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onStartNew();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onKeepGoing();
        return;
      }
      // Left/Right move focus between the two buttons; Enter/Space then
      // activate the focused one via native button behavior.
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        startNewRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        keepGoingRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStartNew, onKeepGoing]);

  return (
    <div
      role="alertdialog"
      aria-label="Topic shift suggestion"
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-accent/40 bg-surface/80 text-xs"
    >
      <div className="text-sm text-text">This looks like a new topic.</div>
      <div className="flex items-center gap-2">
        <button
          ref={startNewRef}
          type="button"
          onClick={onStartNew}
          className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
        >
          Start new conversation
        </button>
        <button
          ref={keepGoingRef}
          type="button"
          onClick={onKeepGoing}
          className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
        >
          Keep going
        </button>
      </div>
    </div>
  );
}
