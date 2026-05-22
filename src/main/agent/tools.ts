import { z } from 'zod';
import type { ActionClass } from '@shared/messages';

export interface OttoTool {
  name: string;
  description: string;
  actionClass: ActionClass;
  schema: z.ZodTypeAny;
  /** Optional pre-execution check. Return a deny reason string or null. */
  denyPatterns?(input: unknown): string | null;
  run(input: unknown): Promise<unknown>;
}

export const echoTool: OttoTool = {
  name: 'echo',
  description: 'Echoes back its input. Used to verify the tool-call pipeline.',
  actionClass: 'read',
  schema: z.object({ msg: z.string() }),
  async run(input) {
    const parsed = echoTool.schema.parse(input) as { msg: string };
    return parsed.msg;
  },
};

export const fakeMutateTool: OttoTool = {
  name: 'fake-mutate',
  description:
    'Pretends to mutate state. Tagged destructive so the autonomy framework prompts for approval. No real side effects.',
  actionClass: 'destructive',
  schema: z.object({ target: z.string() }),
  async run(input) {
    const parsed = fakeMutateTool.schema.parse(input) as { target: string };
    return `Pretended to mutate ${parsed.target}`;
  },
};

export const fakeWipeTool: OttoTool = {
  name: 'fake-wipe',
  description:
    'Pretends to perform an irreversible wipe. Tagged irreversible so the autonomy framework treats it strictly. No real side effects.',
  actionClass: 'irreversible',
  schema: z.object({ target: z.string() }),
  async run(input) {
    const parsed = fakeWipeTool.schema.parse(input) as { target: string };
    return `Pretended to wipe ${parsed.target}`;
  },
};

export const stubTools: OttoTool[] = [echoTool, fakeMutateTool, fakeWipeTool];
