import { useState } from 'react';
import { classifyResult } from '@shared/tool-presenters';
import type { ResultView } from '@shared/tool-presenters';
import { ToolIcon } from './ToolIcon';
import { ImageCard } from '@renderer-shared/tool-cards/ImageCard';

export interface FilmStripCapture {
  callId: string;
  name: string;
  input: unknown;
  result: unknown;
  markers?: Array<{ x: number; y: number; label?: string }>;
}

/**
 * Settled multi-capture receipt (spec §3): N screenshots in one activity run
 * collapse to `Screen · N captures · M clicks [thumb thumb thumb] ✓ review
 * all`, expanding to a gallery. Merged click markers stay on their captures.
 */
export function FilmStrip({ captures, clicks }: { captures: FilmStripCapture[]; clicks: number }) {
  const [open, setOpen] = useState(false);

  const views = captures
    .map((c) => {
      let v = classifyResult(c.name, c.result, false, c.input);
      if (v.kind === 'image' && c.markers && c.markers.length > 0) v = { ...v, markers: c.markers };
      return v;
    })
    .filter((v): v is Extract<ResultView, { kind: 'image' }> => v.kind === 'image');

  const counts = [
    `${captures.length} captures`,
    ...(clicks > 0 ? [`${clicks} click${clicks === 1 ? '' : 's'}`] : []),
  ].join(' · ');

  if (!open) {
    return (
      <div className="relative my-1">
        <button
          type="button"
          data-testid="film-strip"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className="otto-receipt w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:border-accent/40 transition-colors"
        >
          <span className="w-4 h-4 rounded bg-accent/10 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
            <ToolIcon name="camera" className="w-2.5 h-2.5" />
          </span>
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[11px] font-medium flex-shrink-0">Screen</span>
            <span className="text-[11px] text-muted truncate">{counts}</span>
          </span>
          <span className="flex items-center gap-1 flex-1 min-w-0 justify-center" aria-hidden>
            {views.slice(0, 4).map((v, i) => (
              <img
                key={i}
                src={v.src}
                alt=""
                loading="lazy"
                className="h-7 w-11 object-cover rounded-[4px] border border-border flex-shrink-0"
              />
            ))}
          </span>
          <span className="flex items-center gap-1.5 flex-shrink-0 text-[10.5px] text-muted">
            <svg viewBox="0 0 24 24" className="w-3 h-3 text-accent" fill="none" stroke="currentColor"
                 strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12l5 5L20 7" />
            </svg>
            review all
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative my-2 rounded-[10px] otto-elevated overflow-hidden">
      <button
        type="button"
        aria-expanded={true}
        onClick={() => setOpen(false)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface/40 transition-colors"
      >
        <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
          <ToolIcon name="camera" className="w-3.5 h-3.5" />
        </span>
        <span className="flex items-baseline gap-1.5 min-w-0 flex-1 text-left">
          <span className="text-[12.5px] font-semibold">Screen</span>
          <span className="text-[11px] text-muted">{counts}</span>
        </span>
        <svg viewBox="0 0 24 24" className="w-3 h-3 text-muted" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div data-testid="film-strip-gallery" className="px-3 pb-3 border-t border-border/40 pt-3 grid grid-cols-2 gap-2">
        {views.map((v, i) => (
          <ImageCard key={i} view={v} compact />
        ))}
      </div>
    </div>
  );
}
