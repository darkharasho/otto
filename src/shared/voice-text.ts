// src/shared/voice-text.ts
// Turns streamed assistant text deltas into speakable sentences: strips
// content that should never be spoken (code fences, long inline code, raw
// URLs, markdown syntax) and emits complete sentences as soon as their
// boundary arrives so TTS can start before the full message finishes.

const INLINE_CODE_MAX_WORDS = 3;

function sanitize(text: string): string {
  let t = text;
  // Emoji and pictographs (including ZWJ sequences, variation selectors, skin-tone modifiers).
  // The Extended_Pictographic property covers the full emoji set; additional ranges handle
  // variation selector U+FE0F, ZWJ U+200D, and skin-tone modifiers U+1F3FB–U+1F3FF.
  // We also catch the standalone heart U+2764 and related dingbats.
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{2764}]/gu, '');
  // Inline code: keep short spans (reads naturally, e.g. command names),
  // drop long ones.
  t = t.replace(/`([^`]*)`/g, (_m, code: string) => {
    const words = code.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= INLINE_CODE_MAX_WORDS ? code.trim() : '';
  });
  // URLs read terribly aloud.
  t = t.replace(/https?:\/\/\S+/g, 'link');
  // Markdown structure: headings, bullets, emphasis, bold.
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/(^|\s)_([^_]+)_(?=\s|$|[.,!?])/g, '$1$2');
  // Collapse whitespace runs left behind by removals.
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

// Minimum sanitized-text length for an eager first-clause emission.
// Avoids waiting for a full sentence boundary on the very first clause
// (e.g. "Sure, let me check that." emits "Sure, let me check that" at the comma)
// while still requiring enough text that ultra-short interjections like "Sure,"
// alone still come through (12 chars is intentionally low — those are natural).
const EAGER_FIRST_CLAUSE_MIN_CHARS = 12;

// Clause-boundary pattern: comma / semicolon / colon / em-dash followed by whitespace.
const CLAUSE_BOUNDARY_RE = /([,;:]| —)\s+/;

export class SpeechTextStream {
  private buf = '';
  private inFence = false;
  private readonly eagerFirstClause: boolean;
  /** True until the first sentence/clause is emitted after construction or reset/flush. */
  private firstPending = true;

  constructor(opts?: { eagerFirstClause?: boolean }) {
    this.eagerFirstClause = opts?.eagerFirstClause ?? false;
  }

  push(delta: string): string[] {
    this.buf += delta;
    return this.extract(false);
  }

  flush(): string[] {
    const out = this.extract(true);
    this.reset();
    return out;
  }

  reset(): void {
    this.buf = '';
    this.inFence = false;
    this.firstPending = true;
  }

  private extract(final: boolean): string[] {
    const sentences: string[] = [];
    // Phase A: remove code fences from the buffer, tracking open state.
    let speakable = '';
    let rest = this.buf;
    for (;;) {
      if (this.inFence) {
        const close = rest.indexOf('```');
        if (close === -1) {
          // Whole remaining buffer is inside a fence.
          this.buf = final ? '' : rest;
          rest = '';
          break;
        }
        rest = rest.slice(close + 3);
        this.inFence = false;
      } else {
        const open = rest.indexOf('```');
        if (open === -1) {
          speakable += rest;
          this.buf = '';
          rest = '';
          break;
        }
        speakable += rest.slice(0, open);
        rest = rest.slice(open + 3);
        this.inFence = true;
      }
    }

    // Phase B: split speakable text into sentences; hold back the tail
    // (and anything with an unclosed inline-code span) unless final.
    // Sentence boundaries:
    //   - [.!?] followed by whitespace or end of string
    //   - any run of newlines (heading / bullet line breaks count)
    // When eagerFirstClause is true, the very first emission also treats clause
    // boundaries (,  ;  :  " — ") as sentence boundaries, provided the sanitized
    // text meets EAGER_FIRST_CLAUSE_MIN_CHARS. This lowers time-to-first-speech.
    // Known limitations: ellipses ("...") are treated as three sentence-ends;
    // decimal numbers (e.g. "3.14") and abbreviations (e.g. "Dr.") split mid-phrase;
    // em-dash separated clauses are not treated as boundaries (except in eager mode).
    let pending = speakable;
    for (;;) {
      const sentenceMatch = pending.match(/([.!?])(\s+|$)|\n+/);

      // Eager first-clause: when we haven't emitted yet, also test clause boundaries.
      let m = sentenceMatch;
      if (this.eagerFirstClause && this.firstPending && !final) {
        const clauseMatch = pending.match(CLAUSE_BOUNDARY_RE);
        const clausePunct = clauseMatch?.[1]; // the matched punctuation char (, ; : or —)
        if (clauseMatch && clauseMatch.index !== undefined && clausePunct !== undefined) {
          const clauseEnd = clauseMatch.index + clauseMatch[0].length;
          // Prefer whichever boundary comes first (sentence wins ties).
          if (!sentenceMatch || sentenceMatch.index === undefined || clauseMatch.index < sentenceMatch.index) {
            // Only use the clause boundary for the very first emission, and only if
            // the sanitized text meets the minimum length threshold.
            // Include the punctuation char in the slice (so we advance past it),
            // but strip trailing clause punctuation from the spoken text so TTS
            // doesn't say "Sure comma let me check" etc.
            const clauseCandidate = pending.slice(0, clauseMatch.index + clausePunct.length);
            if ((clauseCandidate.match(/`/g)?.length ?? 0) % 2 === 0) {
              const clauseClean = sanitize(clauseCandidate).replace(/[,;:]$/, '').trim();
              if (clauseClean.length >= EAGER_FIRST_CLAUSE_MIN_CHARS) {
                // Emit this clause as the first speech unit.
                sentences.push(clauseClean);
                this.firstPending = false;
                pending = pending.slice(clauseEnd);
                continue;
              }
            }
          }
        }
      }

      if (!m || m.index === undefined) break;
      const end = m.index + (m[1] ? 1 : 0);
      const candidate = pending.slice(0, end);
      const restStart = m.index + m[0].length;
      // Unclosed inline code span: wait for the closing backtick.
      if (!final && (candidate.match(/`/g)?.length ?? 0) % 2 === 1) break;
      const clean = sanitize(candidate).trim();
      if (clean) {
        sentences.push(clean);
        this.firstPending = false;
      }
      pending = pending.slice(restStart);
    }

    if (final) {
      const clean = sanitize(pending).trim();
      if (clean) sentences.push(clean);
    } else if (!this.inFence) {
      // Re-buffer the unfinished tail ahead of any fence-stripped remainder.
      this.buf = pending + this.buf;
    } else if (pending.trim()) {
      // Tail before an open fence: keep it buffered until the fence closes
      // or the message ends. Note buf currently holds the fence interior.
      this.buf = pending + '```' + this.buf;
      this.inFence = false;
    }
    return sentences;
  }
}
