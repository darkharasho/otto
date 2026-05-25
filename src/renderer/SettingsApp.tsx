import { useEffect, useState } from 'react';
import { useOttoStore } from './state/store';
import { ipc } from './ipc';
import { OttoMark } from './components/OttoMark';
import { SettingsShell } from './components/settings/SettingsShell';
import { defaultSubFor, subsFor, type TabId } from './components/settings/SettingsNav';
import { ModelSection } from './components/settings/ModelSection';
import { WindowSection } from './components/settings/WindowSection';
import { ShortcutSection } from './components/settings/ShortcutSection';
import { RemoteDesktopSection } from './components/settings/RemoteDesktopSection';
import { MobileRemoteSection } from './components/settings/MobileRemoteSection';
import { StartupSection } from './components/settings/StartupSection';
import { AutonomySection } from './components/settings/AutonomySection';
import { NotificationsSection } from './components/settings/NotificationsSection';
import { SessionHistorySection } from './components/settings/SessionHistorySection';
import { MemorySection, type MemoryKind } from './components/settings/MemorySection';
import { AboutSection } from './components/settings/AboutSection';
import { UpdatesSection } from './components/settings/UpdatesSection';
import type { SettingsView } from '@shared/ipc-contract';

export function SettingsApp() {
  const model = useOttoStore((s) => s.model);
  const setModel = useOttoStore((s) => s.setModel);
  const [s, setS] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [activeSub, setActiveSub] = useState<string>(defaultSubFor('general'));

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

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    setActiveSub(defaultSubFor(tab));
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

        <SettingsShell
          activeTab={activeTab}
          onTabChange={handleTabChange}
          sidebar={subsFor(activeTab)}
          activeSub={activeSub}
          onSubChange={setActiveSub}
        >
          {renderSubsection({
            activeTab,
            activeSub,
            settings: s,
            model,
            setModel,
            patch,
            patchNotifications,
          })}
        </SettingsShell>
      </div>
    </div>
  );
}

interface RenderArgs {
  activeTab: TabId;
  activeSub: string;
  settings: SettingsView;
  model: string;
  setModel: (m: string) => void;
  patch<K extends keyof SettingsView>(key: K, value: SettingsView[K]): void;
  patchNotifications(p: Partial<SettingsView['notifications']>): void;
}

function renderSubsection(args: RenderArgs) {
  const { activeTab, activeSub, settings: s, model, setModel, patch, patchNotifications } = args;

  if (activeTab === 'general') {
    if (activeSub === 'model') return <ModelSection value={model} onChange={setModel} />;
    if (activeSub === 'window')
      return (
        <WindowSection
          windowPosition={s.windowPosition}
          hideOnBlur={s.hideOnBlur}
          onPositionChange={(position) => {
            patch('windowPosition', position);
            void ipc.invoke('settings.setWindowPosition', { position });
          }}
          onHideOnBlurChange={(v) => {
            patch('hideOnBlur', v);
            void ipc.invoke('settings.setHideOnBlur', { enabled: v });
          }}
        />
      );
    if (activeSub === 'shortcut') return <ShortcutSection />;
    if (activeSub === 'remoteDesktop') return <RemoteDesktopSection />;
    if (activeSub === 'mobileRemote') return <MobileRemoteSection />;
    if (activeSub === 'startup')
      return (
        <StartupSection
          startAtLogin={s.startAtLogin}
          onChange={(v) => {
            patch('startAtLogin', v);
            void ipc.invoke('settings.setStartAtLogin', { enabled: v });
          }}
        />
      );
  }

  if (activeTab === 'behavior') {
    if (activeSub === 'autonomy')
      return (
        <AutonomySection
          mode={s.autonomy.mode}
          onChange={(mode) => {
            patch('autonomy', { mode });
            void ipc.invoke('autonomy.setMode', { mode });
          }}
        />
      );
    if (activeSub === 'notifications')
      return (
        <NotificationsSection
          notifications={s.notifications}
          onChange={(p) => {
            patchNotifications(p);
            void ipc.invoke('settings.setNotifications', p);
          }}
        />
      );
    if (activeSub === 'sessionHistory')
      return (
        <SessionHistorySection
          autoDeleteDays={s.autoDeleteDays}
          onAutoDeleteDaysChange={(days) => {
            patch('autoDeleteDays', days);
            void ipc.invoke('settings.setAutoDeleteDays', { days });
          }}
          onResetAllSessions={async () => {
            await ipc.invoke('settings.resetAllSessions', undefined);
          }}
        />
      );
  }

  if (activeTab === 'memory') {
    const kind = activeSub as MemoryKind;
    return <MemorySection kind={kind} />;
  }

  if (activeTab === 'about') {
    if (activeSub === 'versionLogs')
      return (
        <AboutSection
          version={s.version}
          onOpenLogs={() => void ipc.invoke('settings.openLogsDir', undefined)}
        />
      );
    if (activeSub === 'updates') return <UpdatesSection version={s.version} />;
  }

  return null;
}
