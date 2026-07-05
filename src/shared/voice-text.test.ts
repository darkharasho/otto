// src/shared/voice-text.test.ts
import { describe, it, expect } from 'vitest';
import { SpeechTextStream } from './voice-text';

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
});
