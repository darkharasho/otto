import { describe, it, expect, vi } from 'vitest';
import { capture } from './executor';
import type { PlatformAdapter, CaptureResult } from '../platform';

function fakeAdapter(result: CaptureResult): PlatformAdapter {
  return {
    name: 'linux',
    detectDisplayServer: () => 'x11',
    defaultHotkey: () => 'Super+Space',
    shell: { spawnShell: () => ({} as never), composeEnv: () => ({}) },
    screenshot: {
      capture: vi.fn(async () => result),
    },
  } as unknown as PlatformAdapter;
}

describe('capture', () => {
  it('delegates to adapter.screenshot.capture and returns its result', async () => {
    const fixture: CaptureResult = {
      bytes: Buffer.from('png'),
      width: 100,
      height: 50,
      monitors: [{ id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 }],
    };
    const adapter = fakeAdapter(fixture);
    const r = await capture({ region: undefined }, adapter);
    expect(r).toEqual(fixture);
    expect(adapter.screenshot.capture).toHaveBeenCalledWith({ region: undefined });
  });

  it('forwards a region option', async () => {
    const fixture: CaptureResult = {
      bytes: Buffer.from('png'),
      width: 100,
      height: 50,
      monitors: [{ id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 }],
    };
    const adapter = fakeAdapter(fixture);
    const region = { x: 10, y: 20, w: 30, h: 40 };
    await capture({ region }, adapter);
    expect(adapter.screenshot.capture).toHaveBeenCalledWith({ region });
  });

  it('propagates rejections from the adapter', async () => {
    const adapter = fakeAdapter({} as CaptureResult);
    (adapter.screenshot.capture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(capture({}, adapter)).rejects.toThrow('boom');
  });
});
