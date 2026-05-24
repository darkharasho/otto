import type { Repo } from '../db/repo';
import type { ArtifactKind, ArtifactRepo } from '../db/artifact-repo';
import type { ReflectOutcome } from './reflector';
import { appendKnowledge, readKnowledge } from '../knowledge/store';
import { filterNovelFacts } from '../knowledge/dedup';
import { buildTranscriptSlice } from './transcript';
import { buildReflectorPrompt } from './prompt';
import { logger } from '../logger';

const TRANSCRIPT_BUDGET_BYTES = 30_000 * 4;
const HARD_CAP_PER_KIND = 500;

export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  notifyLearned: (count: number) => void;
}

export interface PipelineResult {
  savedFacts: number;
  savedArtifacts: number;
  capReached: ArtifactKind[];
  skipped: boolean;
  reason?: string;
}

export class ReflectionPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(args: { sessionId: string; sinceSeq: number }): Promise<PipelineResult> {
    const { repo, artifactRepo, configDir, runReflector, notifyLearned } = this.deps;
    const allMessages = repo.loadMessages(args.sessionId);
    const slice = allMessages.filter((m) => m.seq > args.sinceSeq);
    if (slice.length === 0) {
      return { savedFacts: 0, savedArtifacts: 0, capReached: [], skipped: true, reason: 'empty-slice' };
    }

    const knowledgeText = await readKnowledge(configDir).catch(() => '');
    const transcript = buildTranscriptSlice(slice, TRANSCRIPT_BUDGET_BYTES);
    const prompt = buildReflectorPrompt({
      originalRequest: transcript.originalRequest,
      transcript: transcript.text,
      knowledgeText,
      existingTitles: artifactRepo.titlesForReflectorContext(),
    });

    const outcome = await runReflector(prompt);
    if (!outcome.ok) {
      logger.warn(`reflector failed: ${outcome.reason}`);
      return { savedFacts: 0, savedArtifacts: 0, capReached: [], skipped: true, reason: outcome.reason };
    }

    const novelFacts = filterNovelFacts(outcome.result.facts, knowledgeText);
    for (const fact of novelFacts) {
      try {
        await appendKnowledge(configDir, fact);
      } catch (err) {
        logger.error('appendKnowledge failed', err);
      }
    }

    const counts = artifactRepo.counts();
    const capReached: ArtifactKind[] = [];
    let savedArtifacts = 0;

    const kindGroups: Array<[ArtifactKind, typeof outcome.result.playbooks]> = [
      ['playbook', outcome.result.playbooks],
      ['anti_pattern', outcome.result.antiPatterns],
      ['heuristic', outcome.result.heuristics],
    ];

    for (const [kind, items] of kindGroups) {
      for (const item of items) {
        const existing = artifactRepo
          .list({ kind, limit: HARD_CAP_PER_KIND })
          .find((a) => a.title.toLowerCase() === item.title.toLowerCase());
        if (!existing && counts[kind] >= HARD_CAP_PER_KIND) {
          if (!capReached.includes(kind)) capReached.push(kind);
          continue;
        }
        try {
          artifactRepo.upsert({
            kind,
            title: item.title,
            body: item.body,
            tags: item.tags,
            sourceSessionId: args.sessionId,
          });
          savedArtifacts += 1;
          if (!existing) counts[kind] += 1;
        } catch (err) {
          logger.error('artifact upsert failed', err);
        }
      }
    }

    const total = novelFacts.length + savedArtifacts;
    if (total > 0) notifyLearned(total);

    return {
      savedFacts: novelFacts.length,
      savedArtifacts,
      capReached,
      skipped: false,
    };
  }
}
