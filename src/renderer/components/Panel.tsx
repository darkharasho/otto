import { type ReactNode } from 'react';

interface Props {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  busy?: boolean;
}

export function Panel({ header, footer, children, busy = false }: Props) {
  return (
    <div className="relative flex flex-col h-full w-full rounded-xl bg-surface border border-border shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg/50">
        {header}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      <div className="border-t border-border px-3 py-2 bg-bg/40">{footer}</div>
      <span
        aria-hidden
        className={[
          'pointer-events-none absolute inset-0 rounded-xl transition-opacity duration-500',
          'bg-[radial-gradient(ellipse_at_top,rgba(124,125,255,0.08),transparent_60%)]',
          busy ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      />
    </div>
  );
}
