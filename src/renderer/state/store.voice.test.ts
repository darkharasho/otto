import { describe, it, expect, beforeEach } from 'vitest';
import { useOttoStore } from './store';

beforeEach(() => {
  useOttoStore.setState({ voiceMode: false, voiceState: 'idle' });
});

describe('voice state', () => {
  it('defaults to off/idle', () => {
    const s = useOttoStore.getState();
    expect(s.voiceMode).toBe(false);
    expect(s.voiceState).toBe('idle');
  });

  it('setVoiceMode toggles mode and resets state to idle when turning off', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('speaking');
    useOttoStore.getState().setVoiceMode(false);
    const s = useOttoStore.getState();
    expect(s.voiceMode).toBe(false);
    expect(s.voiceState).toBe('idle');
  });

  it('setVoiceState updates the state', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('listening');
    expect(useOttoStore.getState().voiceState).toBe('listening');
  });

  it('setVoiceState accepts starting state', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('starting');
    expect(useOttoStore.getState().voiceState).toBe('starting');
  });

  it('setVoiceMode(false) resets starting state to idle', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('starting');
    useOttoStore.getState().setVoiceMode(false);
    expect(useOttoStore.getState().voiceState).toBe('idle');
  });
});
