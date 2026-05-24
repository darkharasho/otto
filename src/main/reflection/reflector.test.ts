import { describe, it, expect, vi } from 'vitest';
import { reflect } from './reflector';
import type { ReflectorSdk } from './reflector';

function scriptedSdk(textChunks: string[]): ReflectorSdk {
  return {
    async run(_prompt, _opts) {
      return textChunks.join('');
    },
  };
}

describe('reflect', () => {
  it('returns parsed result when SDK emits valid JSON', async () => {
    const sdk = scriptedSdk([
      '{',
      '  "facts": ["Browser is Zen"],',
      '  "playbooks": [],',
      '  "antiPatterns": [],',
      '  "heuristics": []',
      '}',
    ]);
    const out = await reflect({
      sdk,
      prompt: 'p',
      timeoutMs: 1000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.facts).toEqual(['Browser is Zen']);
  });

  it('extracts JSON even when wrapped in stray prose or markdown fence', async () => {
    const sdk = scriptedSdk([
      "Sure, here you go:\n```json\n",
      '{ "facts": [], "playbooks": [], "antiPatterns": [], "heuristics": [], "skip_reason": "trivial" }',
      '\n```\n',
    ]);
    const out = await reflect({ sdk, prompt: 'p', timeoutMs: 1000 });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.skip_reason).toBe('trivial');
  });

  it('returns ok=false on malformed JSON', async () => {
    const sdk = scriptedSdk(['not json at all']);
    const out = await reflect({ sdk, prompt: 'p', timeoutMs: 1000 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('parse-error');
  });

  it('returns ok=false on schema violation', async () => {
    const sdk = scriptedSdk(['{ "facts": "not an array" }']);
    const out = await reflect({ sdk, prompt: 'p', timeoutMs: 1000 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('schema-error');
  });

  it('returns ok=false on timeout', async () => {
    const sdk: ReflectorSdk = {
      run: () => new Promise(() => {}),
    };
    const out = await reflect({ sdk, prompt: 'p', timeoutMs: 20 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('timeout');
  });

  it('returns ok=false on SDK error', async () => {
    const sdk: ReflectorSdk = {
      run: async () => {
        throw new Error('boom');
      },
    };
    const out = await reflect({ sdk, prompt: 'p', timeoutMs: 1000 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('sdk-error');
  });
});
