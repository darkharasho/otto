import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dim: number;
  readonly isAvailable: boolean;
}

const DIM = 384;
const BATCH_SIZE = 32;

function noopEmbedder(): Embedder {
  const zero = new Float32Array(DIM);
  return {
    dim: DIM,
    isAvailable: false,
    async embed() {
      return zero;
    },
    async embedBatch(texts) {
      return texts.map(() => zero);
    },
  };
}

function modelDir(): string {
  // process.resourcesPath is *always* set in Electron — in packaged mode it's
  // the app's resources/, in dev it's Electron's own dist/resources/ under
  // node_modules. Only trust it when the app is actually packaged.
  if (app.isPackaged) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) return path.join(resourcesPath, 'embedding');
  }
  try {
    return path.join(app.getAppPath(), 'resources', 'embedding');
  } catch {
    return path.join(process.cwd(), 'resources', 'embedding');
  }
}

interface TransformersPipeline {
  (text: string | string[], opts?: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array; dims: number[] }>;
}

let cachedInstance: Embedder | null = null;
let initFailed = false;

async function loadRealEmbedder(): Promise<Embedder> {
  // @huggingface/transformers (not @xenova/transformers): the repo pins
  // onnxruntime-node to 1.21 process-wide (one libonnxruntime.so per process —
  // see the pnpm override), and xenova v2's Tensor wrapper drops the
  // prototype `location` getter that ort-node 1.21 requires on feeds
  // ("Tensor.location must be a string"). HF transformers v3 is built against
  // ort 1.21 and loads the same local model files.
  const t = (await import('@huggingface/transformers')) as unknown as {
    env: { localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean };
    pipeline: (task: string, model: string, opts?: { dtype?: string }) => Promise<TransformersPipeline>;
  };
  t.env.localModelPath = modelDir();
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  const pipe = await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });

  return {
    dim: DIM,
    isAvailable: true,
    async embed(text) {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    },
    async embedBatch(texts) {
      const all: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const out = await pipe(batch, { pooling: 'mean', normalize: true });
        for (let j = 0; j < batch.length; j += 1) {
          all.push(out.data.slice(j * DIM, (j + 1) * DIM));
        }
      }
      return all;
    },
  };
}

/**
 * Process-singleton embedder. First call to embed() loads the ONNX model
 * (~200ms). If init fails, downgrades to a no-op embedder for the rest of the
 * process lifetime (FTS-only search still works).
 */
export function getEmbedder(): Embedder {
  if (cachedInstance) return cachedInstance;
  if (process.env.OTTO_DISABLE_EMBEDDINGS === '1') {
    cachedInstance = noopEmbedder();
    return cachedInstance;
  }
  if (initFailed) {
    cachedInstance = noopEmbedder();
    return cachedInstance;
  }

  let isAvailableFlag = true;
  let loadPromise: Promise<Embedder> | null = null;
  function loadOnce(): Promise<Embedder> {
    if (!loadPromise) {
      loadPromise = loadRealEmbedder().catch((err) => {
        initFailed = true;
        isAvailableFlag = false;
        logger.error('embedder init failed; falling back to no-op', err);
        cachedInstance = noopEmbedder();
        return cachedInstance;
      });
    }
    return loadPromise;
  }
  cachedInstance = {
    dim: DIM,
    get isAvailable() { return isAvailableFlag; },
    async embed(text) {
      const real = await loadOnce();
      return real.embed(text);
    },
    async embedBatch(texts) {
      const real = await loadOnce();
      return real.embedBatch(texts);
    },
  };
  return cachedInstance;
}

/** Test helper: reset the cached singleton. Not exported via public API. */
export function _resetEmbedderForTests(): void {
  cachedInstance = null;
  initFailed = false;
}
