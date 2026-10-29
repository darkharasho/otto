import { describe, it, expect } from 'vitest';
import { DEFAULT_MODEL, MODELS, currentModelId, modelLabel } from './models';

describe('models', () => {
  it('labels listed models by name and leaves unknown ids raw', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('some-other-model')).toBe('some-other-model');
  });

  it('moves an older saved pick to the newest model of its family', () => {
    expect(currentModelId('claude-opus-4-8')).toBe('claude-opus-5-5');
    expect(currentModelId('claude-sonnet-4-6')).toBe('claude-sonnet-5-5');
    expect(currentModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-5-5');
    expect(currentModelId('claude-fable-5')).toBe('claude-fable-5-1');
  });

  it('keeps listed and unrecognised ids as they are', () => {
    expect(currentModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(currentModelId('some-other-model')).toBe('some-other-model');
  });

  it('defaults to a listed model', () => {
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });
});
