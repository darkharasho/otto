#!/usr/bin/env node
// Downloads the embedding model to resources/embedding/ if not already present.
// Idempotent: if the model file is the right size, exits 0 without redownloading.
import { mkdirSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'resources', 'embedding');
mkdirSync(DIR, { recursive: true });

const FILES = [
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx',
    dest: join(DIR, 'model_quantized.onnx'),
    minBytes: 20_000_000,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json',
    dest: join(DIR, 'tokenizer.json'),
    minBytes: 400_000,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json',
    dest: join(DIR, 'tokenizer_config.json'),
    minBytes: 100,
  },
  {
    url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json',
    dest: join(DIR, 'config.json'),
    minBytes: 100,
  },
];

for (const f of FILES) {
  if (existsSync(f.dest) && statSync(f.dest).size >= f.minBytes) {
    console.log(`[embedding] ${f.dest} already present`);
    continue;
  }
  console.log(`[embedding] downloading ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) {
    console.error(`[embedding] failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  await streamPipeline(res.body, createWriteStream(f.dest));
}
console.log('[embedding] all files present');
