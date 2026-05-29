import { OttoMark } from './OttoMark';

interface Props {
  sessionTitle: string;
  isLive: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
}

export function ChatTitlebar({ sessionTitle, isLive, onMinimize, onToggleMaximize }: Props) {
  return (
    <div
      className="otto-app-drag relative flex items-center justify-between px-3.5 py-2.5"
      style={{
        background: 'linear-gradient(180deg, rgba(124,125,255,0.04), transparent 80%), #0f1014',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-[3px] opacity-[0.16]">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="w-[3px] h-[3px] rounded-full bg-white" />
        ))}
      </div>

      <div className="flex items-center gap-2.5 z-10">
        <OttoMark className="w-5 h-5 text-[#7c7dff]" />
        <span className="text-[13px] text-[#ebecf1] font-semibold">Otto</span>
        <span className="w-[3px] h-[3px] rounded-full bg-[#3a3b41]" />
        <span className="text-[12px] text-[#9598a0] truncate max-w-[280px]">
          {sessionTitle || 'New conversation'}
        </span>
        {isLive && (
          <span
            className="ml-1.5 inline-flex items-center gap-1.5 px-2 py-[2px] rounded-full"
            style={{ background: 'rgba(124,125,255,0.1)', border: '1px solid rgba(124,125,255,0.25)' }}
          >
            <span
              className="w-[5px] h-[5px] rounded-full"
              style={{ background: '#7c7dff', boxShadow: '0 0 6px #7c7dff' }}
            />
            <span className="text-[10px] text-[#cfd0ff] font-semibold tracking-[0.3px]">LIVE</span>
          </span>
        )}
      </div>

      <div className="z-10 flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-[#5b5e66]">
          <kbd className="px-1.5 py-[2px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">
            ↓
          </kbd>
          <span>collapse</span>
          <span className="opacity-40">·</span>
          <kbd className="px-1.5 py-[2px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">
            ⌃␣
          </kbd>
          <span>hide</span>
        </div>
        <span className="w-px h-4 bg-[#2a2b2e]" />
        <div className="otto-app-no-drag flex gap-1">
          <button
            type="button"
            onClick={onMinimize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label="Minimize"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label="Maximize"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
