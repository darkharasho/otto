import { useOttoStore } from './state/store';
import { ModelSwitcher } from './components/ModelSwitcher';
import { OttoMark } from './components/OttoMark';

export function SettingsApp() {
  const model = useOttoStore((s) => s.model);
  const setModel = useOttoStore((s) => s.setModel);

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
          <section>
            <div className="text-xs font-medium text-text">Model</div>
            <div className="text-[11px] text-muted mt-0.5 mb-2">
              Used for every new session. Switch any time.
            </div>
            <ModelSwitcher value={model} onChange={setModel} />
          </section>
        </div>
      </div>
    </div>
  );
}
