import { useEffect, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'observe' }>;

const W = 560;
const H = 96;
const PAD = 8;

function formatClock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatHm(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function isAlert(v: number, view: View): boolean {
  if (view.threshold === undefined) return false;
  return (view.alertWhen ?? 'above') === 'above' ? v > view.threshold : v < view.threshold;
}

/**
 * Violet sparkline over the sample series: area fill, dashed threshold
 * baseline, red dots on alert samples, and an optional before/after divider
 * at the fix moment. Stretches to the card width; strokes stay crisp via
 * vector-effect (the slight dot ellipse under stretch is imperceptible).
 */
function Sparkline({ view, now }: { view: View; now: number }) {
  const s = view.series;
  if (s.length === 0) return null;
  let lo = Math.min(...s);
  let hi = Math.max(...s);
  if (view.threshold !== undefined) {
    lo = Math.min(lo, view.threshold);
    hi = Math.max(hi, view.threshold);
  }
  if (hi === lo) { hi += 1; lo -= 1; }
  const range = hi - lo;
  lo -= range * 0.08;
  hi += range * 0.08;
  const x = (i: number) => PAD + (s.length === 1 ? (W - 2 * PAD) / 2 : (i * (W - 2 * PAD)) / (s.length - 1));
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const points = s.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `M ${x(0).toFixed(1)},${(H - PAD).toFixed(1)} L ${points.replace(/ /g, ' L ')} L ${x(s.length - 1).toFixed(1)},${(H - PAD).toFixed(1)} Z`;

  const end = view.endedAt ?? now;
  const fixFrac = view.fixAt !== undefined && end > view.startedAt
    ? (view.fixAt - view.startedAt) / (end - view.startedAt)
    : null;
  const fixX = fixFrac !== null && fixFrac > 0 && fixFrac < 1 ? PAD + fixFrac * (W - 2 * PAD) : null;

  return (
    <div className="relative">
      <svg
        data-testid="observe-sparkline"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full h-24 rounded-[7px] border border-border bg-term"
        role="img"
        aria-label={`${view.label} over time`}
      >
        <defs>
          <linearGradient id="observe-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c7dff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#7c7dff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {fixX !== null && (
          <rect x={fixX} y={0} width={W - PAD - fixX} height={H} fill="#7c7dff" opacity="0.05" />
        )}
        <path d={area} fill="url(#observe-fill)" />
        {view.threshold !== undefined && (
          <line
            x1={PAD} x2={W - PAD} y1={y(view.threshold)} y2={y(view.threshold)}
            stroke="#8b8d98" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke"
          />
        )}
        <polyline
          points={points}
          fill="none" stroke="#7c7dff" strokeWidth="1.4"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        />
        {s.map((v, i) =>
          isAlert(v, view) ? (
            <circle key={i} data-testid="observe-alert-dot" cx={x(i)} cy={y(v)} r="2.6" fill="#ef4444" />
          ) : null
        )}
        {fixX !== null && (
          <line
            x1={fixX} x2={fixX} y1={0} y2={H}
            stroke="#7c7dff" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {fixX !== null && view.fixAt !== undefined && (
        <div className="absolute inset-x-0 top-0.5 flex font-mono text-[9px] text-muted pointer-events-none">
          <span style={{ width: `${(fixX / W) * 100}%` }} className="pl-1.5">before</span>
          <span className="pl-1">fix applied {formatHm(view.fixAt)}</span>
        </div>
      )}
    </div>
  );
}

const EVENTS_SHOWN = 3;

export function ObserveCard({ view, compact }: { view: View; compact?: boolean }) {
  const watching = view.endedAt === undefined;
  const [now, setNow] = useState(Date.now());
  const [allEvents, setAllEvents] = useState(false);

  // Elapsed ticker while the watch is live.
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [watching]);

  const last = view.series[view.series.length - 1];
  const span = formatSpan((view.endedAt ?? now) - view.startedAt);
  const hidden = Math.max(0, view.events.length - EVENTS_SHOWN);
  const events = allEvents ? view.events : view.events.slice(-EVENTS_SHOWN);

  return (
    <div data-testid="observe-card" className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="flex items-center gap-1.5 min-w-0">
          {watching && (
            <span aria-hidden className="w-[7px] h-[7px] rounded-full bg-accent otto-pulse-dot flex-shrink-0" />
          )}
          <span className={watching ? 'otto-shimmer font-medium' : 'text-muted'}>
            {watching ? `watching · ${view.label}` : view.label}
          </span>
          <span className="font-mono text-[#5f6167]">{span}</span>
        </span>
        <span className="font-mono text-muted flex-shrink-0">
          {last !== undefined && <>last {last} {view.unit}</>}
          {view.threshold !== undefined && (
            <span className="text-[#5f6167]"> · threshold {view.threshold} {view.unit}</span>
          )}
        </span>
      </div>

      {view.series.length > 0 ? (
        <Sparkline view={view} now={now} />
      ) : (
        <div className="h-24 rounded-[7px] border border-border bg-term flex items-center justify-center text-[10.5px] text-muted">
          waiting for the first sample…
        </div>
      )}

      {events.length > 0 && (
        <div className="space-y-0.5">
          {events.map((e, i) => (
            <div key={`${e.t}-${i}`} className="flex items-baseline gap-2 text-[10.5px]">
              <span className="font-mono text-[10px] text-[#5f6167] flex-shrink-0">{formatClock(e.t)}</span>
              <span className={e.level === 'alert' ? 'text-[#ff8f8f]' : 'text-muted'}>{e.text}</span>
            </div>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setAllEvents((v) => !v)}
              className="text-[10.5px] text-muted hover:text-text transition-colors"
            >
              {allEvents ? 'show latest' : `${hidden} more · show all`}
            </button>
          )}
        </div>
      )}

      {view.verdict && (
        <div
          data-testid="observe-verdict"
          className="flex items-center gap-2 rounded-[7px] border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-[11px]"
        >
          <span className={`font-semibold ${view.verdict.ok ? 'text-good' : 'text-danger'}`} aria-hidden>
            {view.verdict.ok ? '✓' : '✗'}
          </span>
          <span>{view.verdict.text}</span>
        </div>
      )}

      <div className="text-[10px] text-muted/70">
        {view.series.length} sample{view.series.length === 1 ? '' : 's'}
        {view.events.filter((e) => e.level === 'alert').length > 0 &&
          ` · ${view.events.filter((e) => e.level === 'alert').length} alert${view.events.filter((e) => e.level === 'alert').length === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}
