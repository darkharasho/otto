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
    'Fact = { "body": string (<=280 chars), "preference": boolean? (see rule 8 — set true for durable facts you want pinned into future sessions) }',
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
    '1. Empty arrays are acceptable when a task is genuinely trivial (single-command lookup, yes/no answer). But ERR ON THE SIDE OF SAVING. If Otto tried something that failed and had to correct course, that is ALWAYS worth capturing — even if the fix was obvious. A future session that skips the wrong approach entirely is strictly better.',
    '2. NEVER include secrets, tokens, API keys, passwords, or any string that looks redacted (e.g. "****", "redacted", "REDACTED"). Drop anything credential-shaped silently.',
    '3. Prefer updating existing titles over inventing near-duplicates. The existing-titles list is below — reuse a title exactly (case-insensitive) and the system will merge.',
    '4. Facts are durable notes about the machine, the OS, the user, or their environment — NOT task summaries ("audio works now" is not a fact; "audio device is Focusrite Scarlett" is). Platform and environment facts are especially valuable ("machine runs macOS 26 Tahoe", "user uses zsh", "pnpm not npm"). Named-context facts about what the user uses are valid ("user plays Librarian: Tidy Up", "user\'s primary browser is Firefox") — they give future sessions useful priors when the same app/game/service comes up again.',
    '5. Anti-patterns must explain the FAILURE MODE so Otto can avoid it next time, not just say "do not X". Platform mismatches count — if Otto tried a Linux-only tool on macOS and had to switch approaches, that is a textbook anti-pattern.',
    '6. Heuristics are critical. When Otto tries approach A, it fails, and approach B works — that is a heuristic ("on macOS, use screencapture instead of xdotool"). Tool selection, platform-specific paths, command differences between OSes — all heuristics. Do NOT skip these.',
    '7. Playbooks cover ANY reusable recipe for a recurring problem the user might hit again — system administration, apps, games, external services, websites. A narrow, well-tagged playbook ("Librarian: Tidy Up — diagnose \'shelf full\' with no empty row", tags: [game, librarian-tidy-up]) is more useful than a generic one. If you researched a problem the user could plausibly hit again, write the playbook.',
    '8. Set "preference": true on facts that are DURABLE properties of this machine or user — things that will still be true next week and that future sessions should see in their priors. Without this flag a fact is recorded but stays cold and will not surface in future system prompts, so default to true for anything that genuinely qualifies. Qualifying examples span THREE categories: (a) ENVIRONMENT — OS / distro / WM ("machine runs Fedora 44 with KDE Wayland"), shell ("user uses zsh"), hardware ("audio device is Focusrite Scarlett", "GPU is NVIDIA RTX 4090"), tooling preferences ("uses pnpm not npm"), learned environment quirks (sandboxed paths, /var/home symlinks); (b) IDENTITY & TASTE — anything about the user as a person that will stay true and shape future conversations: genre / topical preferences ("user likes sci-fi movies", "user prefers dark mode", "user dislikes JavaScript frameworks"), named apps/games/services they use, hobbies, roles, habits, dietary/accessibility needs; (c) STABLE PROJECT CONTEXT — long-lived facts about a recurring project ("Otto is an Electron app", "deploys via GitHub Actions"). Leave preference false/omitted for ephemeral or task-scoped observations ("the build is currently failing", "audio works now", "user is currently choosing a movie for tonight"). The test: would Otto still want to know this fact a month from now, in a totally unrelated session? If yes → preference: true. When in doubt about any durable user/environment fact, prefer true.',
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
