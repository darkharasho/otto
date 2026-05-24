import type { Repo } from '../db/repo';
import type { ArtifactKind, ArtifactRepo } from '../db/artifact-repo';
import type { FactRepo } from '../db/fact-repo';
import type { ReflectOutcome } from './reflector';
import type { ContentBlock } from '@shared/messages';
import { buildTranscriptSlice } from './transcript';
import { buildReflectorPrompt } from './prompt';
import { logger } from '../logger';

const TRANSCRIPT_BUDGET_BYTES = 30_000 * 4;
const HARD_CAP_PER_KIND = 500;

export interface PipelineDeps {
  repo: Repo;
  artifactRepo: ArtifactRepo;
  factRepo: FactRepo;
  configDir: string;
  runReflector: (prompt: string) => Promise<ReflectOutcome>;
  appendSystemNote: (sessionId: string, content: ContentBlock) => void;
}

export interface PipelineResult {
  savedFacts: number;
  savedArtifacts: number;
  savedByKind: { fact: number; playbook: number; anti_pattern: number; heuristic: number };
  capReached: ArtifactKind[];
  skipped: boolean;
  reason?: string;
}

export class ReflectionPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(args: { sessionId: string; sinceSeq: number }): Promise<PipelineResult> {
    const { repo, artifactRepo, factRepo, runReflector, appendSystemNote } = this.deps;
    const allMessages = repo.loadMessages(args.sessionId);
    const slice = allMessages.filter((m) => m.seq > args.sinceSeq);
    if (slice.length === 0) {
      return {
        savedFacts: 0,
        savedArtifacts: 0,
        savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 },
        capReached: [],
        skipped: true,
        reason: 'empty-slice',
      };
    }

    const pinnedFacts = factRepo.listPinned().map((f) => f.body).join('\n');
    const transcript = buildTranscriptSlice(slice, TRANSCRIPT_BUDGET_BYTES);
    const prompt = buildReflectorPrompt({
      originalRequest: transcript.originalRequest,
      transcript: transcript.text,
      knowledgeText: pinnedFacts,
      existingTitles: artifactRepo.titlesForReflectorContext(),
    });

    const outcome = await runReflector(prompt);
    if (!outcome.ok) {
      logger.warn(`reflector failed: ${outcome.reason}`);
      if (outcome.raw) {
        // Truncated to keep the log tidy; full prompt iteration goes via
        // scripts/eval-reflector.ts.
        const preview = outcome.raw.length > 600 ? `${outcome.raw.slice(0, 600)}…(${outcome.raw.length - 600} more)` : outcome.raw;
        logger.warn(`reflector raw output (for prompt tuning):\n${preview}`);
      }
      return {
        savedFacts: 0,
        savedArtifacts: 0,
        savedByKind: { fact: 0, playbook: 0, anti_pattern: 0, heuristic: 0 },
        capReached: [],
        skipped: true,
        reason: outcome.reason,
      };
    }

    let factsWritten = 0;
    for (const f of outcome.result.facts) {
      try {
        const { inserted } = await factRepo.upsert({
          body: f.body,
          preference: f.preference,
          sourceSessionId: args.sessionId,
        });
        if (inserted) factsWritten += 1;
      } catch (err) {
        logger.error('factRepo.upsert failed', err);
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

    const savedByKind: PipelineResult['savedByKind'] = {
      fact: factsWritten,
      playbook: 0,
      anti_pattern: 0,
      heuristic: 0,
    };

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
          await artifactRepo.upsert({
            kind,
            title: item.title,
            body: item.body,
            tags: item.tags,
            sourceSessionId: args.sessionId,
          });
          savedArtifacts += 1;
          savedByKind[kind] += 1;
          if (!existing) counts[kind] += 1;
        } catch (err) {
          logger.error('artifact upsert failed', err);
        }
      }
    }

    const rerank = factRepo.rerank();
    const total = factsWritten + savedArtifacts;
    if (total > 0) {
      appendSystemNote(args.sessionId, {
        type: 'memory-update',
        facts: factsWritten,
        playbooks: savedByKind.playbook,
        antiPatterns: savedByKind.anti_pattern,
        heuristics: savedByKind.heuristic,
        promoted: rerank.promoted.length,
        demoted: rerank.demoted.length,
      });
    }

    return {
      savedFacts: factsWritten,
      savedArtifacts,
      savedByKind,
      capReached,
      skipped: false,
    };
  }
}
