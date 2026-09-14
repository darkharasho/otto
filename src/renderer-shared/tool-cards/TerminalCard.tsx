import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

// Fold quiet middles: > FOLD_THRESHOLD stdout lines keeps the first line,
// every finding line, and the last TAIL_KEEP, with the rest behind
// click-to-unfold rows.
const FOLD_THRESHOLD = 12;
const TAIL_KEEP = 4;

// "Finding" heuristic: lines that likely carry the result's signal survive the
// fold and get a red tint. Word-bounded so "0 errors" (plural) stays quiet.
const FINDING_RE =
  /\b(error|fail(?:ed|ure)?|fatal|panic|denied|refused|timed?[ -]?out|killed|segfault|exception|warning)\b/i;

type Segment =
  | { kind: 'lines'; text: string }
  | { kind: 'finding'; text: string }
  | { kind: 'fold'; count: number };

/** Split stdout into render segments: merged plain runs, tinted finding lines, and fold rows. */
function segmentStdout(lines: string[], folded: boolean): Segment[] {
  const segs: Segment[] = [];
  let plain: string[] = [];
  let hidden = 0;
  const flushPlain = () => {
    if (plain.length > 0) { segs.push({ kind: 'lines', text: plain.join('\n') }); plain = []; }
  };
  const flushHidden = () => {
    if (hidden > 0) { segs.push({ kind: 'fold', count: hidden }); hidden = 0; }
  };
  lines.forEach((line, i) => {
    const finding = FINDING_RE.test(line);
    const kept = !folded || i === 0 || finding || i >= lines.length - TAIL_KEEP;
    if (!kept) { flushPlain(); hidden += 1; return; }
    flushHidden();
    if (finding) { flushPlain(); segs.push({ kind: 'finding', text: line }); }
    else plain.push(line);
  });
  flushPlain();
  flushHidden();
  return segs;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Plain-language failure reason from stderr patterns; falls back to the first stderr line. */
function whyFailed(stderr: string | undefined, exitCode: number): string {
  const s = stderr ?? '';
  if (/command not found|not recognized as an internal/i.test(s)) return "That command isn't installed or isn't on PATH.";
  if (/no such file or directory/i.test(s)) return "A path in the command doesn't exist.";
  if (/permission denied|access is denied/i.test(s)) return 'Permission was denied — this may need elevated rights.';
  if (/connection refused|could not resolve|network is unreachable/i.test(s)) return "Couldn't reach the network target.";
  const first = s.split('\n').find((l) => l.trim());
  return first ? first.trim() : `The command exited with code ${exitCode}.`;
}

export function TerminalCard({ view, compact, onStop }: { view: View; compact?: boolean; onStop?: () => void }) {
  const exit = view.exitCode;
  const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
  const size = compact ? 'text-[10px] p-2' : 'text-[11px] p-2.5';
  const [unfolded, setUnfolded] = useState(false);
  const [copied, setCopied] = useState(false);

  const stdoutLines = useMemo(
    () => (view.stdout ? view.stdout.replace(/\n$/, '').split('\n') : []),
    [view.stdout]
  );
  const foldable = !view.streaming && stdoutLines.length > FOLD_THRESHOLD;
  const folded = foldable && !unfolded;
  const segments = useMemo(
    () => (view.streaming || stdoutLines.length === 0 ? [] : segmentStdout(stdoutLines, folded)),
    [view.streaming, stdoutLines, folded]
  );

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [view.stdout, view.stderr, view.streaming]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText([view.stdout, view.stderr].filter(Boolean).join('\n'));
      setCopied(true);
    } catch { /* clipboard unavailable — button just doesn't confirm */ }
  };

  const output = (
    <>
      {view.streaming && view.stdout && (
        <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>
      )}
      {segments.map((s, i) =>
        s.kind === 'fold' ? (
          <button
            key={i}
            type="button"
            onClick={() => setUnfolded(true)}
            className="block w-full text-left text-muted/70 hover:text-muted border-y border-dashed border-border/60 my-1 py-0.5"
          >
            — {s.count} quiet line{s.count === 1 ? '' : 's'} hidden —
          </button>
        ) : (
          <pre
            key={i}
            {...(s.kind === 'finding' ? { 'data-testid': 'terminal-finding' } : {})}
            className={`whitespace-pre-wrap break-words m-0 ${
              s.kind === 'finding' ? 'bg-[rgba(239,68,68,.09)] text-[#ff8f8f]' : ''
            }`}
          >
            {s.text}
          </pre>
        )
      )}
      {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-[#ff8f8f]">{view.stderr}</pre>}
      {view.streaming && <span className="inline-block w-2 h-3 align-baseline bg-accent/70 otto-blink" />}
    </>
  );

  return (
    <div>
      <div
        ref={ref}
        className={`rounded-[7px] border border-border/70 bg-term font-mono leading-[1.65] ${view.streaming ? '' : 'max-h-[320px] overflow-auto'} ${size}`}
      >
        {view.command && (
          <div className="m-0 whitespace-pre-wrap break-words">
            <span className="text-accent select-none">$ </span>
            <span>{view.command}</span>
          </div>
        )}
        {view.streaming ? <div className="otto-live-tail">{output}</div> : output}
      </div>
      {view.streaming && exit === undefined ? (
        <div className="flex items-center pt-1.5 text-[10.5px] text-muted">
          <span className="otto-shimmer">streaming…</span>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="ml-auto text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-danger text-danger hover:bg-danger/10 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      ) : exit !== undefined ? (
        <>
          <div className="flex items-center gap-1.5 pt-1.5 text-[10.5px] text-muted min-w-0">
            <span className={`font-mono ${exitClass}`}>exit {exit}</span>
            {view.durationMs !== undefined && <span>· {formatDuration(view.durationMs)}</span>}
            <span>· {stdoutLines.length} line{stdoutLines.length === 1 ? '' : 's'}</span>
            {view.takeaway && (
              <span className="text-text/85 truncate" title={view.takeaway}>· {view.takeaway}</span>
            )}
            <button
              type="button"
              onClick={() => void copyOutput()}
              className="ml-auto flex-shrink-0 text-muted hover:text-text transition-colors"
            >
              {copied ? 'Copied' : 'Copy output'}
            </button>
          </div>
          {exit !== 0 && (
            <div className="mt-1.5 rounded-[7px] border border-danger/30 bg-danger/[0.07] px-2.5 py-1.5 text-[10.5px]">
              <span className="text-danger font-medium">Why: </span>
              {/* Agent-supplied explanation (annotate_result `why`) beats the stderr heuristic. */}
              <span className="text-text/85">{view.why ?? whyFailed(view.stderr, exit)}</span>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
