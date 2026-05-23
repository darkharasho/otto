import { useEffect } from 'react';
import { ModelSwitcher } from './ModelSwitcher';

interface Props {
  open: boolean;
  onClose(): void;
  model: string;
  onModelChange(id: string): void;
  modelLocked?: boolean;
  modelLockedReason?: string;
}

export function SettingsModal({
  open,
  onClose,
  model,
  onModelChange,
  modelLocked = false,
  modelLockedReason,
}: Props) {
  // Esc-to-close. Stops propagation so the global Esc handler doesn't also
  // collapse the panel/hide the window when the user just meant "close dialog".
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Otto settings"
      className="absolute inset-0 z-20 flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div className="otto-modal-enter relative w-[420px] max-w-[90%] rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">Settings</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-text rounded p-1"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-4 space-y-5">
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <div className="text-xs font-medium text-text">Model</div>
                <div className="text-[11px] text-muted mt-0.5">
                  Used for every new session. {modelLocked && modelLockedReason
                    ? modelLockedReason
                    : 'Switch any time.'}
                </div>
              </div>
            </div>
            <ModelSwitcher value={model} onChange={onModelChange} disabled={modelLocked} />
          </section>
        </div>
      </div>
    </div>
  );
}
