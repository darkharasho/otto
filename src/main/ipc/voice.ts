import { BrowserWindow, ipcMain } from 'electron';
import { VOICE_EVENT_CHANNEL, type VoiceEvent } from '@shared/voice';
import type { VoiceManager } from '../voice/manager';

export function emitVoiceEvent(event: VoiceEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(VOICE_EVENT_CHANNEL, event);
  }
}

export function registerVoiceIpc(voice: VoiceManager): void {
  ipcMain.handle('voice.setMode', async (_e, args: { enabled: boolean; sessionId: string | null }) => {
    await voice.setMode(args.enabled, args.sessionId);
  });
  ipcMain.handle('voice.transcribe', async (_e, args: { pcm: ArrayBuffer; sampleRate: number }) => {
    const text = await voice.transcribe(new Float32Array(args.pcm), args.sampleRate);
    return { text };
  });
  ipcMain.handle('voice.cancelSpeech', () => {
    voice.cancelSpeech();
  });
}
