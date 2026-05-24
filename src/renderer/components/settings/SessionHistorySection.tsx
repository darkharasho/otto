import { useState } from 'react';
import { Section, NumberField } from '../SettingsControls';

export function SessionHistorySection({
  autoDeleteDays,
  onAutoDeleteDaysChange,
  onResetAllSessions,
}: {
  autoDeleteDays: number;
  onAutoDeleteDaysChange: (days: number) => void;
  onResetAllSessions: () => Promise<void>;
}) {
  return (
    <Section title="Session history" description="Sessions live in a local SQLite database.">
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="flex-1">
          <div className="text-sm">Auto-delete older than</div>
          <div className="text-[11px] text-muted">0 = keep forever.</div>
        </div>
        <NumberField value={autoDeleteDays} onChange={onAutoDeleteDaysChange} suffix="days" />
      </div>
      <div className="pt-1">
        <DangerButton
          label="Delete all sessions…"
          confirm="Permanently delete every saved session?"
          onConfirm={onResetAllSessions}
        />
      </div>
    </Section>
  );
}

function DangerButton({
  label,
  confirm,
  onConfirm,
}: {
  label: string;
  confirm: string;
  onConfirm(): Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className="text-xs text-danger hover:underline">
        {label}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">{confirm}</span>
      <button
        type="button"
        onClick={async () => {
          await onConfirm();
          setArmed(false);
        }}
        className="px-2 py-0.5 rounded bg-danger text-white hover:bg-danger/90"
      >
        Yes
      </button>
      <button type="button" onClick={() => setArmed(false)} className="text-muted hover:text-text">
        Cancel
      </button>
    </div>
  );
}
