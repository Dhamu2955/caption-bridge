import { createHash } from 'node:crypto';

/**
 * Embeddings for cross-language retrieval.
 *
 * §3 wants a Gujarati query to hit an English-indexed passage, which needs a
 * multilingual model sharing one vector space across languages. The default
 * runs locally — no API key, no data leaving the machine, consistent with the
 * localhost-only posture of §9.
 */

export interface Embedder {
  /** Stored alongside each vector so a model change is detectable. */
  readonly id: string;
  readonly dimensions: number;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/**
 * multilingual-e5-small: 384 dimensions, ~118M params, covers Gujarati and
 * English in a shared space. E5 models are trained with "query:" / "passage:"
 * prefixes and degrade noticeably without them.
 */
export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_DIMENSIONS = 384;

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  constructor(model: string = DEFAULT_MODEL, dimensions: number = DEFAULT_DIMENSIONS) {
    this.id = model;
    this.dimensions = dimensions;
  }

  /** Loaded lazily — the model is only fetched when indexing or searching. */
  private async pipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = import('@huggingface/transformers').then(
        async (mod) =>
          (await mod.pipeline('feature-extraction', this.id)) as unknown as FeatureExtractionPipeline,
      );
    }
    return this.pipelinePromise;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.pipeline();
    const output = await extract(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((text) => `passage: ${text}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`query: ${text}`]);
    if (!vector) throw new Error('embedding failed: model returned nothing');
    return vector;
  }
}

/**
 * Deterministic stand-in for tests. Bag-of-hashed-tokens, L2-normalised: it
 * has no semantic power and no cross-language ability, so it is only good for
 * exercising the storage and SQL paths without downloading a model.
 */
export class HashEmbedder implements Embedder {
  readonly id = 'hash-test-embedder';
  readonly dimensions: number;

  constructor(dimensions = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  private vector(text: string): number[] {
    const values = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const digest = createHash('sha1').update(token).digest();
      const slot = digest.readUInt32BE(0) % this.dimensions;
      const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
      values[slot] = (values[slot] ?? 0) + sign;
    }
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? values : values.map((v) => v / norm);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}

/** pgvector literal format: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}
