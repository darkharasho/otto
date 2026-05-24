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
              className={`px-3 py-1 text-xs rounded ${
                selected ? 'bg-accent text-white' : 'bg-bg/40 text-muted hover:text-text'
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
                className={`block w-full text-left px-4 py-1.5 text-xs ${
                  current ? 'bg-accent/15 text-text font-medium' : 'text-muted hover:text-text hover:bg-bg/40'
                }`}
              >
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
