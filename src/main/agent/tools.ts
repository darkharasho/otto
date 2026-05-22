import { z } from 'zod';

export interface OttoTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run(input: unknown): Promise<unknown>;
}

export const echoTool: OttoTool = {
  name: 'echo',
  description: 'Echoes back its input. Used to verify the tool-call pipeline.',
  schema: z.object({ msg: z.string() }),
  async run(input) {
    const parsed = echoTool.schema.parse(input) as { msg: string };
    return parsed.msg;
  },
};

export const stubTools: OttoTool[] = [echoTool];
