import { describe, it, expect } from 'vitest';
import { pcmToWav } from './pcm-wav';

function readU32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(o, true);
}
function readU16(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint16(o, true);
}
function readI16(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getInt16(o, true);
}

describe('pcmToWav', () => {
  it('writes a valid 44-byte RIFF/WAVE header for 16kHz mono 16-bit', () => {
    const wav = pcmToWav(new Float32Array([0, 0.5, -0.5]), 16000);
    expect(wav.length).toBe(44 + 3 * 2);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(readU32(wav, 4)).toBe(wav.length - 8);
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(readU16(wav, 22)).toBe(1); // channels
    expect(readU32(wav, 24)).toBe(16000); // sample rate
    expect(readU32(wav, 28)).toBe(16000 * 2); // byte rate
    expect(readU16(wav, 34)).toBe(16); // bits per sample
    expect(readU32(wav, 40)).toBe(3 * 2); // data chunk size
  });

  it('converts float samples to clamped int16', () => {
    const wav = pcmToWav(new Float32Array([0, 1, -1, 1.5, -1.5]), 16000);
    expect(readI16(wav, 44)).toBe(0);
    expect(readI16(wav, 46)).toBe(32767);
    expect(readI16(wav, 48)).toBe(-32768);
    expect(readI16(wav, 50)).toBe(32767); // clamped
    expect(readI16(wav, 52)).toBe(-32768); // clamped
  });
});
