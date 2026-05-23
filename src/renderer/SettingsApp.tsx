import { useEffect, useState } from 'react';
import { useOttoStore } from './state/store';
import { ipc } from './ipc';
import { ModelSwitcher } from './components/ModelSwitcher';
import { OttoMark } from './components/OttoMark';
import { Section, Toggle, RadioGroup, NumberField } from './components/SettingsControls';
import { UpdaterSection } from './components/UpdaterSection';
import { ShortcutSection } from './components/ShortcutSection';
import type { SettingsView } from '@shared/ipc-contract';
import type { AutonomyMode } from '@shared/messages';

export function SettingsApp() {
  const model = useOttoStore((s) => s.model);
  const setModel = useOttoStore((s) => s.setModel);
  const [s, setS] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ipc.invoke('settings.get', undefined).then(setS).catch((e) => {
      setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    });
  }, []);

  if (err) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-red-400 text-xs p-4 text-center">
        Settings failed to load:<br />
        <code className="mt-2 whitespace-pre-wrap">{err}</code>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-muted text-sm">
        Loading…
      </div>
    );
  }

  function patch<K extends keyof SettingsView>(key: K, value: SettingsView[K]) {
    setS((cur) => (cur ? { ...cur, [key]: value } : cur));
  }
  function patchNotifications(p: Partial<SettingsView['notifications']>) {
    setS((cur) => (cur ? { ...cur, notifications: { ...cur.notifications, ...p } } : cur));
  }

  return (
    <div className="w-screen h-screen p-1 otto-enter">
      <div className="flex flex-col h-full w-full rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg/40"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-2">
            <OttoMark className="w-4 h-4 text-accent" />
            <div className="text-sm font-semibold">Settings</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => window.close()}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="text-muted hover:text-text rounded p-1"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          <Section title="Model" description="Used for every new session.">
            <ModelSwitcher value={model} onChange={setModel} />
          </Section>

          <Section
            title="Autonomy"
            description="How freely Otto can take action without asking."
          >
            <RadioGroup<AutonomyMode>
              value={s.autonomy.mode}
              onChange={(mode) => {
                patch('autonomy', { mode });
                void ipc.invoke('autonomy.setMode', { mode });
              }}
              options={[
                {
                  value: 'strict',
                  label: 'Strict',
                  description: 'Ask before any reversible or destructive action.',
                },
                {
                  value: 'balanced',
                  label: 'Balanced',
                  description: 'Run read-only freely, ask for destructive or irreversible.',
                },
                {
                  value: 'full-allow',
                  label: 'Full allow',
                  description: 'Run everything without asking. Use at your own risk.',
                },
              ]}
            />
          </Section>

          <Section title="Notifications">
            <Toggle
              checked={s.notifications.turnComplete}
              onChange={(v) => {
                patchNotifications({ turnComplete: v });
                void ipc.invoke('settings.setNotifications', { turnComplete: v });
              }}
              label="When Otto finishes responding"
              description="Only fires when the Otto window isn't focused."
            />
            <Toggle
              checked={s.notifications.approval}
              onChange={(v) => {
                patchNotifications({ approval: v });
                void ipc.invoke('settings.setNotifications', { approval: v });
              }}
              label="When Otto needs approval"
              description="Critical priority — won't be silenced by Do Not Disturb."
            />
            <Toggle
              checked={s.notifications.sound}
              onChange={(v) => {
                patchNotifications({ sound: v });
                void ipc.invoke('settings.setNotifications', { sound: v });
              }}
              label="Play sound"
            />
          </Section>

          <Section
            title="Window"
            description="Where the bar and panel appear when summoned."
          >
            <RadioGroup<'bottom-center' | 'top-center'>
              value={s.windowPosition}
              onChange={(position) => {
                patch('windowPosition', position);
                void ipc.invoke('settings.setWindowPosition', { position });
              }}
              options={[
                { value: 'bottom-center', label: 'Bottom center', description: 'Grows upward as the panel opens.' },
                { value: 'top-center', label: 'Top center', description: 'Grows downward as the panel opens.' },
              ]}
            />
            <Toggle
              checked={s.hideOnBlur}
              onChange={(v) => {
                patch('hideOnBlur', v);
                void ipc.invoke('settings.setHideOnBlur', { enabled: v });
              }}
              label="Hide when clicked away"
              description="When on, clicking outside Otto hides it (like a popover). When off, Otto stays open until you dismiss it with the hotkey."
            />
          </Section>

          <ShortcutSection />

          <Section title="System">
            <Toggle
              checked={s.startAtLogin}
              onChange={(v) => {
                patch('startAtLogin', v);
                void ipc.invoke('settings.setStartAtLogin', { enabled: v });
              }}
              label="Start at login"
              description="Run Otto in the background when you sign in."
            />
          </Section>

          <Section
            title="Session history"
            description="Sessions live in a local SQLite database."
          >
            <div className="flex items-center justify-between gap-3 py-1.5">
              <div className="flex-1">
                <div className="text-sm">Auto-delete older than</div>
                <div className="text-[11px] text-muted">0 = keep forever.</div>
              </div>
              <NumberField
                value={s.autoDeleteDays}
                onChange={(days) => {
                  patch('autoDeleteDays', days);
                  void ipc.invoke('settings.setAutoDeleteDays', { days });
                }}
                suffix="days"
              />
            </div>
            <div className="pt-1">
              <DangerButton
                label="Delete all sessions…"
                confirm="Permanently delete every saved session?"
                onConfirm={async () => {
                  await ipc.invoke('settings.resetAllSessions', undefined);
                }}
              />
            </div>
          </Section>

          <UpdaterSection appVersion={s.version} />

          <Section title="About">
            <div className="flex items-center justify-between text-xs text-muted py-1">
              <span>Otto v{s.version}</span>
              <button
                type="button"
                onClick={() => void ipc.invoke('settings.openLogsDir', undefined)}
                className="text-accent hover:underline"
              >
                Open logs folder
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
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
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="text-xs text-danger hover:underline"
      >
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
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-muted hover:text-text"
      >
        Cancel
      </button>
    </div>
  );
}
