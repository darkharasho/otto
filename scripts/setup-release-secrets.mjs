#!/usr/bin/env node
// One-shot: pulls Apple signing creds from 1Password and sets them as
// GitHub Actions secrets on the otto repo. Idempotent — re-running just
// overwrites. Requires `op` (1Password CLI, signed in) and `gh` (signed in).
//
// Usage: node scripts/setup-release-secrets.mjs

import { execFileSync } from 'node:child_process';

const OP_ITEM = 'Apple App Specific Password';
const OP_VAULT = 'Private';
const GH_REPO = 'darkharasho/otto';

function op(ref) {
  return execFileSync('op', ['read', ref], { encoding: 'utf8' }).trim();
}

function setSecret(name, value) {
  console.log(`Setting ${name}...`);
  execFileSync('gh', ['secret', 'set', name, '--repo', GH_REPO, '--body', value], { stdio: 'inherit' });
}

function main() {
  // The SAI cert section UUID in the 1Password item.
  const SAI_SECTION = 'cq4d2obdnqvlw6obucelfsf77y';

  const cscLink = op(`op://${OP_VAULT}/${OP_ITEM}/${SAI_SECTION}/Cert Base64`);
  const cscKeyPassword = op(`op://${OP_VAULT}/${OP_ITEM}/${SAI_SECTION}/Cert Password`);
  const appleId = op(`op://${OP_VAULT}/${OP_ITEM}/username`);
  const appleAppPassword = op(`op://${OP_VAULT}/${OP_ITEM}/password`);
  const appleTeamId = op(`op://${OP_VAULT}/${OP_ITEM}/add more/Team ID`);

  setSecret('CSC_LINK', cscLink);
  setSecret('CSC_KEY_PASSWORD', cscKeyPassword);
  setSecret('APPLE_ID', appleId);
  setSecret('APPLE_APP_SPECIFIC_PASSWORD', appleAppPassword);
  setSecret('APPLE_TEAM_ID', appleTeamId);

  console.log('\nAll release secrets set on', GH_REPO);
}

main();
