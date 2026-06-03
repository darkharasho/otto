import type { ReactNode } from 'react';
import { TABS, type SubEntry, type TabId } from './SettingsNav';

interface Props {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  sidebar: SubEntry[];
  activeSub: string;
  onSubChange: (sub: string) => void;
  children: ReactNode;
}

export function SettingsShell({
  activeTab,
  onTabChange,
  sidebar,
  activeSub,
  onSubChange,
  children,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex gap-1 px-4 py-2 border-b border-border" role="tablist">
        {TABS.map((t) => {
          const selected = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onTabChange(t.id)}
              className={`px-3 py-1 text-[13px] font-medium rounded-md ${
                selected
                  ? 'otto-accent-pill shadow-[inset_0_0_0_1px_rgba(124,125,255,0.3)]'
                  : 'bg-transparent text-muted hover:text-text'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '180px 1fr' }}>
        <nav className="border-r border-border overflow-y-auto py-2">
          {sidebar.map((s) => {
            const current = activeSub === s.id;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={current}
                onClick={() => onSubChange(s.id)}
                className={`relative block w-full text-left px-4 py-1.5 text-[13px] ${
                  current
                    ? 'text-text font-medium bg-gradient-to-r from-accent/[0.14] to-transparent'
                    : 'text-muted hover:text-text hover:bg-bg/40'
                }`}
              >
                {current && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />}
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="overflow-y-auto px-5 py-5 space-y-6">{children}</div>
      </div>
    </div>
  );
}
