// src/shared/voice-text.test.ts
import { describe, it, expect } from 'vitest';
import { SpeechTextStream } from './voice-text';

describe('SpeechTextStream eagerFirstClause', () => {
  it('emits on comma when clause meets min-length threshold', () => {
    const s = new SpeechTextStream({ eagerFirstClause: true });
    // Leading clause "Let me check that for you" (25 chars before comma+space) meets the ≥12
    // threshold, so the stream emits at the comma rather than waiting for the period.
    // The remainder is held until its own boundary arrives.
    expect(s.push('Let me check that for you, and report back. ')).toEqual([
      'Let me check that for you',
      'and report back.',
    ]);
  });

  it('subsequent commas do NOT split (only normal sentence boundaries apply after first emission)', () => {
    const s = new SpeechTextStream({ eagerFirstClause: true });
    // Force first emission via a sentence boundary first, then commas in subsequent
    // sentence should NOT split.
    expect(s.push('Hello there. Now, one more thing, right? Yes.')).toEqual([
      'Hello there.',
      'Now, one more thing, right?',
      'Yes.',
    ]);
  });

  it('short leading clause under threshold waits for sentence boundary', () => {
    const s = new SpeechTextStream({ eagerFirstClause: true });
    // "Hi" — 2 chars before comma — below 12-char threshold; waits for period.
    expect(s.push('Hi, how are you doing today.')).toEqual(['Hi, how are you doing today.']);
  });

  it('resets restores eagerness — next push can emit on first clause again', () => {
    const s = new SpeechTextStream({ eagerFirstClause: true });
    // Trigger first emission via sentence boundary.
    s.push('Let me look into that right now. ');
    // Reset.
    s.reset();
    // After reset, eager mode is active again; long first clause (≥12 chars) splits at comma.
    expect(s.push('I found the answer you need, so here we go. ')).toEqual([
      'I found the answer you need',
      'so here we go.',
    ]);
  });

  it('flush restores eagerness on subsequent use', () => {
    const s = new SpeechTextStream({ eagerFirstClause: true });
    s.push('Running the check right now. ');
    s.flush();
    // After flush+reset, eager again; long leading clause (≥12 chars) emits at comma.
    expect(s.push('Checking the results now, here is what I found. ')).toEqual([
      'Checking the results now',
      'here is what I found.',
    ]);
  });
});

describe('SpeechTextStream', () => {
  it('emits a sentence once its boundary arrives, keeps the tail buffered', () => {
    const s = new SpeechTextStream();
    expect(s.push('Checking your processes now. I found')).toEqual([
      'Checking your processes now.',
    ]);
    expect(s.push(' three of them.')).toEqual(['I found three of them.']);
  });

  it('handles boundaries split across deltas', () => {
    const s = new SpeechTextStream();
    expect(s.push('Done')).toEqual([]);
    expect(s.push('. Next step.')).toEqual(['Done.', 'Next step.']);
  });

  it('treats a blank line as a sentence boundary', () => {
    const s = new SpeechTextStream();
    expect(s.push('First point\n\nSecond point.')).toEqual(['First point', 'Second point.']);
  });

  it('drops fenced code blocks entirely, even across deltas', () => {
    const s = new SpeechTextStream();
    const out = [
      ...s.push('Here is the fix.\n```ts\nconst x'),
      ...s.push(' = 1;\n```\nApplied it.'),
      ...s.flush(),
    ];
    expect(out).toEqual(['Here is the fix.', 'Applied it.']);
  });

  it('keeps short inline code, drops long inline code', () => {
    const s = new SpeechTextStream();
    expect(s.push('Run `pnpm test` to check.')).toEqual(['Run pnpm test to check.']);
    const long = s.push('Use `const result = await client.messages.create(options)` here.');
    expect(long).toEqual(['Use here.']);
  });

  it('waits for an unclosed inline code span instead of emitting it raw', () => {
    const s = new SpeechTextStream();
    expect(s.push('Run `pnpm ')).toEqual([]);
    expect(s.push('test` now.')).toEqual(['Run pnpm test now.']);
  });

  it('replaces URLs with "link"', () => {
    const s = new SpeechTextStream();
    expect(s.push('See https://example.com/a/b?c=d for details.')).toEqual([
      'See link for details.',
    ]);
  });

  it('strips markdown headings, bullets, emphasis', () => {
    const s = new SpeechTextStream();
    const out = [...s.push('## Summary\n- **Bold** point one.\n- _Quiet_ point two.'), ...s.flush()];
    expect(out).toEqual(['Summary', 'Bold point one.', 'Quiet point two.']);
  });

  it('flush returns the sanitized tail and resets', () => {
    const s = new SpeechTextStream();
    s.push('All done');
    expect(s.flush()).toEqual(['All done']);
    expect(s.flush()).toEqual([]);
  });

  it('reset drops buffered content', () => {
    const s = new SpeechTextStream();
    s.push('Pending text');
    s.reset();
    expect(s.flush()).toEqual([]);
  });

  it('never emits empty or whitespace-only sentences', () => {
    const s = new SpeechTextStream();
    const out = [...s.push('```\ncode only\n```'), ...s.flush()];
    expect(out).toEqual([]);
  });

  it('strips emoji mid-sentence without leaving double spaces', () => {
    const s = new SpeechTextStream();
    expect(s.push('Great job 🎉 well done.')).toEqual(['Great job well done.']);
  });

  it('produces nothing for emoji-only content', () => {
    const s = new SpeechTextStream();
    const out = [...s.push('🎉🚀'), ...s.flush()];
    expect(out).toEqual([]);
  });

  it('strips ZWJ sequences like 👩‍💻', () => {
    const s = new SpeechTextStream();
    // 👩‍💻 = woman + ZWJ + laptop — all three codepoints should be removed
    expect(s.push('Your developer 👩‍💻 is ready.')).toEqual(['Your developer is ready.']);
  });
});
