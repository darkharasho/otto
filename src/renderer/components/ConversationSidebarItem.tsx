import type { SidebarSession, StatusDot } from '../lib/conversation-grouping';

interface Props {
  session: SidebarSession;
  status: StatusDot;
  /**
   * Reserved for future per-session tool history. Not rendered today —
   * callers currently pass `[]` and the unused slot added visual noise.
   */
  glyphs?: string[];
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
  session, status, active, pinned, subtitle, onSelect, onTogglePin,
}: Props) {
  const baseRow =
    'group relative flex items-center gap-2.5 px-3 py-2 rounded-[9px] cursor-pointer transition-all duration-150';
  const activeRow =
    'border border-[rgba(124,125,255,0.28)] bg-gradient-to-r from-[rgba(124,125,255,0.13)] to-[rgba(124,125,255,0.02)] shadow-[inset_0_0_14px_rgba(124,125,255,0.07)]';
  const idleRow = 'border border-transparent hover:bg-white/[0.035]';

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
          className="absolute left-[-1px] top-2 bottom-2 w-[2px] rounded-[2px]"
          style={{ background: 'linear-gradient(180deg,#7c7dff,#a882ff)', boxShadow: '0 0 8px rgba(124,125,255,0.7)' }}
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
        <div className="text-[10px] text-[#6b6e76] mt-[2px] tracking-[0.1px]">{subtitle}</div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
        className={`w-[14px] flex-shrink-0 text-[11px] leading-none text-[#9598a0] transition-opacity duration-150 ${
          pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        aria-label={pinned ? 'Unpin' : 'Pin'}
      >
        {pinned ? '★' : '☆'}
      </button>
    </div>
  );
}
