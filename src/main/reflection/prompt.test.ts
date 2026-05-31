import { describe, it, expect } from 'vitest';
import { buildReflectorPrompt } from './prompt';

describe('buildReflectorPrompt', () => {
  it('includes all input sections and the JSON schema', () => {
    const out = buildReflectorPrompt({
      originalRequest: 'fix audio',
      transcript: 'USER: fix audio\nASSISTANT: ok',
      knowledgeText: '- (2026-05-22) Browser is Zen',
      existingTitles: [{ kind: 'playbook', title: 'Restart audio', tags: ['audio'] }],
    });
    expect(out).toContain('fix audio');
    expect(out).toContain('Browser is Zen');
    expect(out).toContain('Restart audio');
    expect(out).toContain('"facts"');
    expect(out).toContain('"playbooks"');
    expect(out).toContain('skip_reason');
  });

  it('explicitly forbids storing secrets', () => {
    const out = buildReflectorPrompt({
      originalRequest: '',
      transcript: '',
      knowledgeText: '',
      existingTitles: [],
    });
    expect(out.toLowerCase()).toContain('secret');
    expect(out).toMatch(/redacted|\*{4}/i);
  });

  it('says empty arrays are encouraged', () => {
    const out = buildReflectorPrompt({
      originalRequest: '',
      transcript: '',
      knowledgeText: '',
      existingTitles: [],
    });
    expect(out.toLowerCase()).toContain('empty');
  });

  it('documents the preference flag on facts', () => {
    const out = buildReflectorPrompt({
      originalRequest: '',
      transcript: '',
      knowledgeText: '',
      existingTitles: [],
    });
    expect(out).toContain('Fact = ');
    expect(out).toContain('preference');
  });

  it('instructs the model when to set preference: true', () => {
    const out = buildReflectorPrompt({
      originalRequest: '',
      transcript: '',
      knowledgeText: '',
      existingTitles: [],
    });
    expect(out).toContain('"preference": true');
    expect(out.toLowerCase()).toContain('durable');
    expect(out.toLowerCase()).toMatch(/future system prompt|future session/);
    expect(out.toLowerCase()).toContain('ephemeral');
  });

  it('covers taste/identity preferences, not just environment facts', () => {
    const out = buildReflectorPrompt({
      originalRequest: '',
      transcript: '',
      knowledgeText: '',
      existingTitles: [],
    });
    const lower = out.toLowerCase();
    expect(lower).toContain('identity');
    expect(lower).toContain('taste');
    expect(lower).toMatch(/sci-fi|genre|hobbies|habits/);
  });
});
