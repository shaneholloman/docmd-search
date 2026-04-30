/**
 * --------------------------------------------------------------------
 * docmd-search : offline semantic search for docs, zero-config.
 *
 * @package     docmd-search (and ecosystem)
 * @website     https://docmd.io/search
 * @repository  https://github.com/docmd-io/docmd-search
 * @license     MIT
 * @copyright   Copyright (c) 2026-present docmd.io
 *
 * [docmd-source] - Please do not remove this header.
 * --------------------------------------------------------------------
 */

/**
 * Embedding Model Manager.
 *
 * Wraps @huggingface/transformers + onnxruntime-node to provide:
 * - Model download with progress tracking
 * - Batch embedding generation
 * - Float32 → Int8 quantization
 *
 * ONNX Runtime is the inference engine (runs the model in Node.js).
 * The model files (e.g., MiniLM at ~30MB) determine speed/quality.
 * User picks the model; the runtime stays the same.
 */

import { getModelProfile } from './config.js';
import type { ModelProfile } from './config.js';

/* ── Types ─────────────────────────────────────────────────── */

export type ProgressPhase = 'loading' | 'downloading' | 'ready';

export interface ModelProgress {
  phase: ProgressPhase;
  /** Download progress 0–100 (only during 'downloading' phase). */
  progress?: number;
  /** Human-readable status message. */
  message: string;
}

export type OnModelProgress = (progress: ModelProgress) => void;

export interface ModelManager {
  /** The model profile being used. */
  profile: ModelProfile;
  /** Load the model (downloads if not cached). */
  load(): Promise<void>;
  /** Check if the model is loaded and ready. */
  isLoaded(): boolean;
  /** Generate embeddings for an array of texts. Batches internally. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Release model resources. */
  dispose(): void;
}

/* ── Peer Dependency Check ─────────────────────────────────── */

/**
 * Check if the required peer dependencies are available.
 * Returns an object with the missing deps, or null if all present.
 */
export function checkPeerDeps(): { missing: string[] } | null {
  const missing: string[] = [];

  try {
    // Just check if the module resolves, don't import it
    import.meta.resolve?.('@huggingface/transformers');
  } catch {
    missing.push('@huggingface/transformers');
  }

  try {
    import.meta.resolve?.('onnxruntime-node');
  } catch {
    missing.push('onnxruntime-node');
  }

  return missing.length > 0 ? { missing } : null;
}

/**
 * Format a helpful error message when peer deps are missing.
 */
export function formatMissingDepsMessage(missing: string[]): string {
  const pkgs = missing.join(' ');
  return [
    '',
    '  ⚠ Missing required dependencies for embedding:',
    '',
    `    npm install ${pkgs}`,
    '',
    '  These are optional peer dependencies — only needed when generating',
    '  embeddings. The search client (browser) does not need them.',
    '',
  ].join('\n');
}

/* ── Quantization ──────────────────────────────────────────── */

/**
 * Quantize Float32 vectors to Int8 using per-vector min/max scaling.
 *
 * Each vector is independently scaled to [-128, 127] range.
 * This achieves ~4x compression with minimal quality loss for
 * cosine similarity operations.
 */
export function quantizeToInt8(vectors: Float32Array[]): Int8Array[] {
  return vectors.map(vec => {
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < vec.length; i++) {
      if (vec[i] < min) min = vec[i];
      if (vec[i] > max) max = vec[i];
    }

    const range = max - min || 1;
    const quantized = new Int8Array(vec.length);

    for (let i = 0; i < vec.length; i++) {
      // Scale to [-128, 127]
      quantized[i] = Math.round(((vec[i] - min) / range) * 255 - 128);
    }

    return quantized;
  });
}

/* ── Model Manager Factory ─────────────────────────────────── */

/** Embedding batch size — how many texts to embed at once. */
const BATCH_SIZE = 32;

/**
 * Create a ModelManager instance for the given model.
 *
 * @param modelId - HuggingFace model identifier (e.g., 'Xenova/all-MiniLM-L6-v2')
 * @param onProgress - Optional callback for download/load progress
 */
export function createModelManager(
  modelId: string,
  onProgress?: OnModelProgress
): ModelManager {
  const profile = getModelProfile(modelId);

  let pipeline: any = null;
  let loaded = false;

  const notify = (phase: ProgressPhase, message: string, progress?: number) => {
    onProgress?.({ phase, message, progress });
  };

  return {
    profile,

    async load(): Promise<void> {
      if (loaded) return;

      notify('loading', `Loading model: ${profile.name}...`);

      try {
        // Dynamic import — only loads @huggingface/transformers when actually needed
        const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

        // Configure ONNX Runtime backend
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = 1; // Single thread for stability
        }

        // Track download progress
        let lastProgress = 0;
        const progressCallback = (data: any) => {
          if (data.status === 'progress' && data.progress != null) {
            const pct = Math.round(data.progress);
            if (pct !== lastProgress) {
              lastProgress = pct;
              notify('downloading', `Downloading ${profile.name}...`, pct);
            }
          }
        };

        // Create the feature-extraction pipeline
        pipeline = await createPipeline('feature-extraction', profile.id, {
          progress_callback: progressCallback,
          dtype: 'fp32',
        });

        loaded = true;
        notify('ready', `Model ready: ${profile.name}`);
      } catch (err: any) {
        const message = err?.message ?? String(err);

        // Check for common issues
        if (message.includes('Cannot find module') || message.includes('MODULE_NOT_FOUND')) {
          throw new Error(
            `Missing dependency: @huggingface/transformers or onnxruntime-node.\n` +
            `Install with: npm install @huggingface/transformers onnxruntime-node`
          );
        }

        throw new Error(`Failed to load model "${profile.id}": ${message}`);
      }
    },

    isLoaded(): boolean {
      return loaded;
    },

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!loaded || !pipeline) {
        throw new Error('Model not loaded. Call load() first.');
      }

      const allEmbeddings: Float32Array[] = [];

      // Process in batches to avoid memory issues
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);

        // Run inference
        const output = await pipeline(batch, {
          pooling: 'mean',
          normalize: true,
        });

        // Extract Float32Arrays from the output tensor
        for (let j = 0; j < batch.length; j++) {
          const embedding = new Float32Array(profile.dimensions);

          for (let k = 0; k < profile.dimensions; k++) {
            embedding[k] = output.data[j * profile.dimensions + k];
          }

          allEmbeddings.push(embedding);
        }
      }

      return allEmbeddings;
    },

    dispose(): void {
      pipeline = null;
      loaded = false;
    },
  };
}
