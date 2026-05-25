import type { ArtifactKind } from '../db/artifact-repo';

export interface PromptInputs {
  originalRequest: string;
  transcript: string;
  knowledgeText: string;
  existingTitles: { kind: ArtifactKind; title: string; tags: string[] }[];
}

export function buildReflectorPrompt(input: PromptInputs): string {
  const existingBlock =
    input.existingTitles.length === 0
      ? '(none yet)'
      : input.existingTitles
          .map((e) => `- [${e.kind}] ${e.title}${e.tags.length ? ` (tags: ${e.tags.join(', ')})` : ''}`)
          .join('\n');

  return [
    'You are the reflection step for Otto, a desktop coworking agent. A task just finished. Your job is to read the transcript below and extract durable lessons that will help Otto on FUTURE tasks on this same machine.',
    '',
    'Return a single JSON object matching this shape — and nothing else (no prose, no markdown fences):',
    '',
    '{',
    '  "facts":        Fact[],     // short standalone notes about the machine or user',
    '  "playbooks":    Artifact[], // named procedures worth following again',
    '  "antiPatterns": Artifact[], // things that did NOT work, with the reason',
    '  "heuristics":   Artifact[], // meta-rules about Otto\'s own tools (e.g. "prefer kdotool over click on Wayland")',
    '  "skip_reason":  string?    // optional one-line explanation if all arrays are empty',
    '}',
    '',
    'Fact = { "body": string (<=280 chars), "preference": boolean? (true = stable user/machine preference) }',
    'Artifact = { "title": string (<=120 chars), "body": markdown string (<=4000 chars), "tags": string[] (<=8, lowercase keywords) }',
    '',
    'Playbook body convention:',
    '  ## When to use',
    '  ...',
    '  ## Steps',
    '  1. ...',
    '  ## Notes',
    '  - ...',
    '',
    'RULES — read carefully:',
    '1. Empty arrays are not just acceptable, they are encouraged. Most short tasks yield nothing worth saving. If the task was trivial or you saw nothing novel, return all-empty and put a one-line "skip_reason".',
    '2. NEVER include secrets, tokens, API keys, passwords, or any string that looks redacted (e.g. "****", "redacted", "REDACTED"). Drop anything credential-shaped silently.',
    '3. Prefer updating existing titles over inventing near-duplicates. The existing-titles list is below — reuse a title exactly (case-insensitive) and the system will merge.',
    '4. Facts are durable notes about the machine or user, NOT task summaries ("audio works now" is not a fact; "audio device is Focusrite Scarlett" is). Named-context facts about what the user uses are valid ("user plays Librarian: Tidy Up", "user\'s primary browser is Firefox") — they give future sessions useful priors when the same app/game/service comes up again.',
    '5. Anti-patterns must explain the FAILURE MODE so Otto can avoid it next time, not just say "do not X".',
    '6. Playbooks cover ANY reusable recipe for a recurring problem the user might hit again — system administration, apps, games, external services, websites. A narrow, well-tagged playbook ("Librarian: Tidy Up — diagnose \'shelf full\' with no empty row", tags: [game, librarian-tidy-up]) is more useful than a generic one. If you researched a problem the user could plausibly hit again, write the playbook.',
    '',
    '---',
    'ORIGINAL USER REQUEST:',
    input.originalRequest || '(no user request in slice)',
    '',
    '---',
    'TRANSCRIPT:',
    input.transcript || '(empty)',
    '',
    '---',
    'CURRENT pinned facts (do not duplicate facts already here):',
    input.knowledgeText || '(empty)',
    '',
    '---',
    'EXISTING ARTIFACT TITLES (reuse a title to update, invent a new one to insert):',
    existingBlock,
    '',
    '---',
    'Return only the JSON object now.',
  ].join('\n');
}
