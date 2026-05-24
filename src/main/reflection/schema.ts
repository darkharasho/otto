import { z } from 'zod';

const tagsSchema = z
  .array(z.string().min(1).max(40))
  .max(8)
  .transform((tags) => tags.map((t) => t.toLowerCase()));

const factSchema = z.object({
  body: z.string().min(1).max(280),
  preference: z.boolean().optional(),
});

const artifactSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
  tags: tagsSchema,
});

export const ReflectionResultSchema = z.object({
  facts: z.array(factSchema).max(20),
  playbooks: z.array(artifactSchema).max(10),
  antiPatterns: z.array(artifactSchema).max(10),
  heuristics: z.array(artifactSchema).max(10),
  skip_reason: z.string().max(500).optional(),
});

export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;
export type ReflectionArtifact = z.infer<typeof artifactSchema>;
