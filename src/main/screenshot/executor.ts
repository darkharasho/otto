import type { CaptureOptions, CaptureResult, PlatformAdapter } from '../platform';

export async function capture(
  opts: CaptureOptions,
  adapter: PlatformAdapter
): Promise<CaptureResult> {
  return adapter.screenshot.capture(opts);
}
