// src/shared/voice-text.ts
// Turns streamed assistant text deltas into speakable sentences: strips
// content that should never be spoken (code fences, long inline code, raw
// URLs, markdown syntax) and emits complete sentences as soon as their
// boundary arrives so TTS can start before the full message finishes.

const INLINE_CODE_MAX_WORDS = 3;

function sanitize(text: string): string {
  let t = text;
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

export class SpeechTextStream {
  private buf = '';
  private inFence = false;

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
    let pending = speakable;
    for (;;) {
      const m = pending.match(/([.!?])(\s+|$)|\n+/);
      if (!m || m.index === undefined) break;
      const end = m.index + (m[1] ? 1 : 0);
      const candidate = pending.slice(0, end);
      const restStart = m.index + m[0].length;
      // Unclosed inline code span: wait for the closing backtick.
      if (!final && (candidate.match(/`/g)?.length ?? 0) % 2 === 1) break;
      const clean = sanitize(candidate).trim();
      if (clean) sentences.push(clean);
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
