import { ToolIcon } from './ToolIcon';
import { describeTool } from '@shared/tool-presenters';
import type { SidebarSession, StatusDot } from '../lib/conversation-grouping';

interface Props {
  session: SidebarSession;
  status: StatusDot;
  glyphs: string[];
  active: boolean;
  pinned: boolean;
  subtitle: string;
  onSelect: () => void;
  onTogglePin: () => void;
}

const DOT_COLOR: Record<StatusDot, string> = {
  running: '#7c7dff',
  done: '#3a3b41',
  errored: '#e25555',
  idle: '#3a3b41',
};

export function ConversationSidebarItem({
  session, status, glyphs, active, pinned, subtitle, onSelect, onTogglePin,
}: Props) {
  const baseRow =
    'group relative flex items-center gap-2.5 px-3 py-2 rounded-[9px] cursor-pointer transition-colors';
  const activeRow =
    'border border-[rgba(124,125,255,0.35)] bg-gradient-to-r from-[rgba(124,125,255,0.18)] to-[rgba(124,125,255,0.04)] shadow-[inset_0_0_18px_rgba(124,125,255,0.1),0_4px_14px_rgba(124,125,255,0.06)]';
  const idleRow = 'hover:bg-white/5';

  return (
    <div
      className={`${baseRow} ${active ? activeRow : idleRow}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-[-1px] top-2 bottom-2 w-[3px] rounded-[3px]"
          style={{ background: 'linear-gradient(180deg,#7c7dff,#a882ff)', boxShadow: '0 0 10px #7c7dff' }}
        />
      )}
      <span
        aria-hidden
        className={`flex-shrink-0 w-[7px] h-[7px] rounded-full ${status === 'running' ? 'otto-pulse-dot' : ''}`}
        style={{ background: DOT_COLOR[status], boxShadow: status === 'running' ? '0 0 8px #7c7dff' : 'none' }}
      />
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] truncate ${active ? 'text-white font-semibold' : 'text-[#cfd2d8] font-medium'}`}>
          {session.title}
        </div>
        <div className="text-[10px] text-[#6b6e76] mt-[2px]">{subtitle}</div>
      </div>
      <div className="flex gap-[3px] flex-shrink-0">
        {glyphs.map((g) => {
          const desc = describeTool(g);
          return (
            <span
              key={g}
              title={desc.label}
              className="w-[11px] h-[11px] rounded-[3px] flex items-center justify-center"
              style={{ background: 'rgba(124,125,255,0.18)', border: '1px solid rgba(124,125,255,0.35)' }}
            >
              <ToolIcon name={desc.icon} className="w-[8px] h-[8px] text-[#cfd0ff]" />
            </span>
          );
        })}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
        className="opacity-0 group-hover:opacity-100 text-[10px] text-[#9598a0] px-1"
        aria-label={pinned ? 'Unpin' : 'Pin'}
      >
        {pinned ? '★' : '☆'}
      </button>
    </div>
  );
}
