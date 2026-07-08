import { ReflectionResultSchema, type ReflectionResult } from './schema';
import { ZodError } from 'zod';

export interface ReflectorSdk {
  run(prompt: string, opts: { model: string; signal: AbortSignal }): Promise<string>;
}

export interface ReflectArgs {
  sdk: ReflectorSdk;
  prompt: string;
  model?: string;
  timeoutMs: number;
}

export type ReflectOutcome =
  | { ok: true; result: ReflectionResult; raw: string }
  | { ok: false; reason: 'timeout' | 'sdk-error' | 'parse-error' | 'schema-error'; raw?: string; error?: unknown };

export async function reflect(args: ReflectArgs): Promise<ReflectOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ __timeout: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ __timeout: true });
    }, args.timeoutMs);
  });
  let raw: string;
  try {
    const result = await Promise.race([
      args.sdk.run(args.prompt, {
        model: args.model ?? 'claude-haiku-4-5-20251001',
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (typeof result === 'object' && result !== null && '__timeout' in result) {
      return { ok: false, reason: 'timeout' };
    }
    raw = result as string;
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'sdk-error', error: err };
  }
  if (timer) clearTimeout(timer);

  const json = extractFirstJsonObject(raw);
  if (json === null) return { ok: false, reason: 'parse-error', raw };

  try {
    const parsed = ReflectionResultSchema.parse(json);
    return { ok: true, result: parsed, raw };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, reason: 'schema-error', raw, error: err };
    }
    throw err;
  }
}

export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
