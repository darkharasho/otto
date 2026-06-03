import { ArrowDown, Minus, Square, Copy, Lock } from 'lucide-react';
import { OttoMark } from './OttoMark';

interface Props {
  sessionTitle: string;
  isLive: boolean;
  isPrivate?: boolean;
  isMaximized: boolean;
  hideChord: string | null;
  onMinimize: () => void;
  onToggleMaximize: () => void;
}

const KEY_GLYPHS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  super: 'Super',
  alt: 'Alt',
  option: '⌥',
  shift: '⇧',
  space: '␣',
  enter: '↵',
  escape: 'Esc',
  esc: 'Esc',
  tab: 'Tab',
};

function renderChord(chord: string): string {
  return chord
    .split('+')
    .map((p) => KEY_GLYPHS[p.trim().toLowerCase()] ?? p.trim())
    .join(' ');
}

export function ChatTitlebar({
  sessionTitle,
  isLive,
  isPrivate = false,
  isMaximized,
  hideChord,
  onMinimize,
  onToggleMaximize,
}: Props) {
  return (
    <div
      className="otto-app-drag relative flex items-center justify-between px-3.5 py-2.5"
      style={{
        background: 'linear-gradient(180deg, rgba(124,125,255,0.04), transparent 80%), #0f1014',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-center gap-2.5 z-10 min-w-0">
        <OttoMark className="w-5 h-5 text-[#7c7dff]" />
        <span className="text-[13px] text-[#ebecf1] font-semibold">Otto</span>
        <span className="w-[3px] h-[3px] rounded-full bg-[#3a3b41] flex-shrink-0" />
        <span
          className={`text-[12px] truncate max-w-[280px] ${sessionTitle ? 'text-[#9598a0]' : 'text-[#5b5e66]'}`}
        >
          {sessionTitle || 'New conversation'}
        </span>
        {isPrivate && (
          <span
            data-testid="private-indicator"
            title="Private conversation — nothing here is saved to history, learned, or written to memory"
            className="ml-1.5 inline-flex items-center gap-1 px-2 py-[2px] rounded-full flex-shrink-0"
            style={{ background: 'rgba(124,125,255,0.12)', border: '1px solid rgba(124,125,255,0.3)' }}
          >
            <Lock className="w-[10px] h-[10px] text-[#cfd0ff]" strokeWidth={2.4} aria-hidden />
            <span className="text-[10px] text-[#cfd0ff] font-semibold tracking-[0.3px]">PRIVATE</span>
          </span>
        )}
        {isLive && (
          <span
            className="ml-1.5 inline-flex items-center gap-1.5 px-2 py-[2px] rounded-full flex-shrink-0"
            style={{ background: 'rgba(124,125,255,0.1)', border: '1px solid rgba(124,125,255,0.25)' }}
          >
            <span
              className="w-[5px] h-[5px] rounded-full otto-pulse-dot"
              style={{ background: '#7c7dff', boxShadow: '0 0 6px #7c7dff' }}
            />
            <span className="text-[10px] text-[#cfd0ff] font-semibold tracking-[0.3px]">LIVE</span>
          </span>
        )}
      </div>

      <div className="z-10 flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-[#5b5e66]">
          <kbd className="inline-flex items-center justify-center px-1 py-[3px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] text-[#9598a0]">
            <ArrowDown className="w-[10px] h-[10px]" strokeWidth={2} aria-hidden />
          </kbd>
          <span>collapse</span>
          <span className="opacity-40">·</span>
          {hideChord && (
            <>
              <kbd className="px-1.5 py-[2px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">
                {renderChord(hideChord)}
              </kbd>
              <span>hide</span>
            </>
          )}
        </div>
        <span className="w-px h-4 bg-[#2a2b2e]" />
        <div className="otto-app-no-drag flex gap-1">
          <button
            type="button"
            onClick={onMinimize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0] transition-colors hover:text-white hover:bg-[#1b1c22]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label="Minimize"
          >
            <Minus className="w-[11px] h-[11px]" strokeWidth={2.4} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0] transition-colors hover:text-white hover:bg-[#1b1c22]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <Copy className="w-[10px] h-[10px] -scale-x-100" strokeWidth={2} aria-hidden />
            ) : (
              <Square className="w-[10px] h-[10px]" strokeWidth={2} aria-hidden />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
