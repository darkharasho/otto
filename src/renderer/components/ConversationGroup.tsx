import type { ReactNode } from 'react';

interface Props {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Earlier';
  children: ReactNode;
}

export function ConversationGroup({ label, children }: Props) {
  const isPinned = label === 'Pinned';
  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1.5">
        {isPinned && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="#7c7dff" aria-hidden>
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        )}
        <span
          className={`text-[9px] uppercase font-bold tracking-[1.4px] ${isPinned ? 'text-[#7c7dff]' : 'text-[#6b6e76]'}`}
        >
          {label}
        </span>
        <span
          className="flex-1 h-px"
          style={{
            background: isPinned
              ? 'linear-gradient(90deg, rgba(124,125,255,0.25), transparent)'
              : 'linear-gradient(90deg, rgba(255,255,255,0.05), transparent)',
          }}
        />
      </div>
      <div className="flex flex-col gap-0.5 px-1.5">{children}</div>
    </>
  );
}
