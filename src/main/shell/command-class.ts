import type { ActionClass } from '@shared/messages';

const PREFIX_STRIP = /^\s*(?:sudo\s+|nice(?:\s+-n\s+-?\d+)?\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)+\s+)+/;

function normalize(command: string): string {
  return command.replace(PREFIX_STRIP, '').trimStart();
}

const READ_ALLOWLIST: RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^grep\b/,
  /^find\b.*\s-type\b/,
  /^find\b(?!.*\s-(?:delete|exec))/,
  /^head\b/,
  /^tail\b(?!.*\s-f\b)/,
  /^wc\b/,
  /^pwd\b/,
  /^which\b/,
  /^echo\b/,
  /^printf\b/,
  /^date\b/,
  /^whoami\b/,
  /^id\b/,
  /^uname\b/,
  /^ps\b/,
  /^top\b.*\s-bn1\b/,
  /^df\b/,
  /^du\b/,
  /^stat\b/,
  /^file\b/,
  /^git\s+(?:status|log|diff|show|branch|remote|rev-parse)\b/,
];

const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /\brm\s+-[rR]f?\b/,
  /\brm\s+-f[rR]\b/,
  /\bdd\b.*\bof=/,
  /\bmkfs\./,
];

const DENY_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'rm-rf-root', pattern: /\brm\s+(?:-[rRf]+\s+)+(?:--no-preserve-root\s+)?\/(?:\s|$)/ },
  { name: 'rm-rf-root', pattern: /\brm\s+-rf\s+--no-preserve-root\s+\// },
  { name: 'dd-to-block-device', pattern: /\bdd\b.*\bof=\/dev\/(?:sd|nvme|hd|vd)/ },
  { name: 'mkfs', pattern: /\bmkfs\./ },
  { name: 'shred-device', pattern: /\bshred\b.*\s\/dev\// },
  { name: 'fork-bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'redirect-to-block-device', pattern: />\s*\/dev\/(?:sd|nvme|hd|vd)/ },
  { name: 'chmod-root', pattern: /\bchmod\s+-R\s+0{1,3}\s+\// },
];

export function classify(command: string): ActionClass {
  const cmd = normalize(command);
  for (const re of IRREVERSIBLE_PATTERNS) if (re.test(cmd)) return 'irreversible';
  for (const re of READ_ALLOWLIST) if (re.test(cmd)) return 'read';
  return 'destructive';
}

export function denyReason(command: string): string | null {
  for (const rule of DENY_RULES) if (rule.pattern.test(command)) return rule.name;
  return null;
}
