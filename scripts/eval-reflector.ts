/**
 * Usage: npx tsx scripts/eval-reflector.ts <transcripts-dir>
 *
 * Each .txt file in the directory is treated as a transcript slice. The script
 * builds a reflector prompt against it (with empty knowledge and empty existing
 * titles) and prints the parsed result (or failure reason). For prompt tuning
 * only — not part of the test suite.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { buildReflectorPrompt } from '../src/main/reflection/prompt';
import { reflect } from '../src/main/reflection/reflector';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: eval-reflector.ts <transcripts-dir>');
    process.exit(1);
  }
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.txt'));
  for (const f of files) {
    const transcript = await fsp.readFile(path.join(dir, f), 'utf8');
    const prompt = buildReflectorPrompt({
      originalRequest: '',
      transcript,
      knowledgeText: '',
      existingTitles: [],
    });
    const out = await reflect({
      sdk: {
        async run(_p, _opts) {
          throw new Error('Wire this script up to your local Claude SDK before use.');
        },
      },
      prompt,
      timeoutMs: 60_000,
    });
    console.log('===', f, '===');
    console.log(JSON.stringify(out, null, 2));
  }
}

void main();
