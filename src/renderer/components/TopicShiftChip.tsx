import { useEffect } from 'react';

interface Props {
  onStartNew(): void;
  onKeepGoing(): void;
}

export function TopicShiftChip({ onStartNew, onKeepGoing }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onKeepGoing();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKeepGoing]);

  return (
    <div
      role="alertdialog"
      aria-label="Topic shift suggestion"
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-accent/40 bg-surface/80 text-xs"
    >
      <div className="text-sm text-text">This looks like a new topic.</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onStartNew}
          className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
        >
          Start new conversation
        </button>
        <button
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
