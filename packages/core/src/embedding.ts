import { createHash } from "node:crypto";
import type { Chunk, EmbeddingProvider } from "./types.js";

/**
 * The single source of truth for constructing the text payload sent to embedding models.
 * Both `provider.embed()` and `computeFingerprint()` use this function.
 */
export function toEmbeddingInput(chunk: Chunk): string {
  const context = chunk.breadcrumb || chunk.filepath;
  return `Context: ${context}\n\nContent:\n${chunk.content_text}`;
}

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function computeConfigFingerprint(fields: Record<string, string | number>): string {
  const parts = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return sha256hex(parts.join("\0"));
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  baseUrl?: string;
  concurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = "none";
  readonly model = "none";
  readonly dimensions = 0;
  readonly configFingerprint: string;

  constructor() {
    this.configFingerprint = computeConfigFingerprint({
      provider: "none",
      model: "none",
      dimensions: 0,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash";
  readonly model: string;
  readonly dimensions: number;
  readonly configFingerprint: string;

  constructor(options: { dimensions?: number; model?: string } = {}) {
    this.dimensions = options.dimensions ?? 256;
    this.model = options.model ?? "hash-v1";
    this.configFingerprint = computeConfigFingerprint({
      provider: "hash",
      model: this.model,
      dimensions: this.dimensions,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashToUnitVector(text, this.dimensions));
  }
}

/**
 * Conservative character limit per text input to stay under the 8191-token
 * context window of OpenAI embedding models.  We use ~3 chars/token as a
 * safety margin so 8000 * 3 = 24 000 characters.
 */
const DEFAULT_MAX_INPUT_CHARS = 24_000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  readonly configFingerprint: string;

  private readonly apiKey: string;
  readonly batchSize: number;
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OpenAIEmbeddingProvider requires a non-empty apiKey");
    }

    this.apiKey = options.apiKey;
    this.model = options.model ?? "text-embedding-3-large";
    this.dimensions = options.dimensions ?? 3072;
    this.batchSize = options.batchSize ?? 128;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.concurrency = normalizeInt(options.concurrency, 4, 1, 32);
    this.maxRetries = normalizeInt(options.maxRetries, 3, 0, 10);
    this.retryBaseDelayMs = normalizeInt(options.retryBaseDelayMs, 500, 50, 60_000);
    this.retryMaxDelayMs = normalizeInt(options.retryMaxDelayMs, 10_000, 100, 120_000);
    this.configFingerprint = computeConfigFingerprint({
      provider: "openai",
      model: this.model,
      dimensions: this.dimensions,
      baseUrl: this.baseUrl,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(texts.length);
    const batches: Array<{ offset: number; values: string[] }> = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push({
        offset: i,
        values: texts.slice(i, i + this.batchSize)
      });
    }

    await runWithConcurrency(batches, this.concurrency, async (batch) => {
      const batchVectors = await this.embedBatchWithRetry(batch.values);
      for (let i = 0; i < batchVectors.length; i += 1) {
        vectors[batch.offset + i] = batchVectors[i];
      }
    });

    if (vectors.some((vector) => vector === undefined)) {
      throw new Error("OpenAI embeddings response was missing one or more vectors");
    }

    return vectors as number[][];
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let attempt = 0;
    const truncated = batch.map((text) => {
      if (text.length > DEFAULT_MAX_INPUT_CHARS) {
        console.warn(
          `[docs-mcp] Embedding input truncated from ${text.length} to ${DEFAULT_MAX_INPUT_CHARS} characters. ` +
            `Consider lowering max_chunk_size in your chunking strategy to avoid content loss.`
        );
        return text.slice(0, DEFAULT_MAX_INPUT_CHARS);
      }
      return text;
    });

    while (true) {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: truncated,
          dimensions: this.dimensions
        })
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          data?: Array<{ index: number; embedding: number[] }>;
        };

        if (!Array.isArray(payload.data)) {
          throw new Error("OpenAI embeddings response missing data array");
        }

        const ordered = [...payload.data].sort((a, b) => a.index - b.index);
        if (ordered.length !== batch.length) {
          throw new Error(
            `OpenAI embeddings response size mismatch: expected ${batch.length}, got ${ordered.length}`
          );
        }

        return ordered.map((item) => item.embedding);
      }

      const body = await response.text();
      if (!isRetryableStatus(response.status) || attempt >= this.maxRetries) {
        throw new Error(
          `OpenAI embeddings request failed (${response.status}): ${body.slice(0, 500)}`
        );
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const backoffMs = Math.min(
        this.retryMaxDelayMs,
        Math.max(
          retryAfterMs,
          this.retryBaseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250)
        )
      );

      await sleep(backoffMs);
      attempt += 1;
    }
  }
}

export function createEmbeddingProvider(input: {
  provider: "none" | "hash" | "openai";
  dimensions?: number;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}): EmbeddingProvider {
  if (
    input.provider !== "none" &&
    input.provider !== "hash" &&
    input.provider !== "openai"
  ) {
    throw new Error(
      `unsupported embedding provider '${String(input.provider)}'. Expected one of: none, hash, openai`
    );
  }

  if (input.provider === "none") {
    return new NoopEmbeddingProvider();
  }

  if (input.provider === "hash") {
    const options: { dimensions?: number; model?: string } = {};
    if (input.dimensions !== undefined) {
      options.dimensions = input.dimensions;
    }
    if (input.model !== undefined) {
      options.model = input.model;
    }
    return new HashEmbeddingProvider(options);
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      `${input.provider} embedding provider requires --embedding-api-key or OPENAI_API_KEY`
    );
  }

  const options: OpenAIEmbeddingProviderOptions = { apiKey };
  if (input.model !== undefined) {
    options.model = input.model;
  }
  if (input.dimensions !== undefined) {
    options.dimensions = input.dimensions;
  }
  if (input.baseUrl !== undefined) {
    options.baseUrl = input.baseUrl;
  }
  if (input.batchSize !== undefined) {
    options.batchSize = input.batchSize;
  }
  if (input.concurrency !== undefined) {
    options.concurrency = input.concurrency;
  }
  if (input.maxRetries !== undefined) {
    options.maxRetries = input.maxRetries;
  }
  if (input.retryBaseDelayMs !== undefined) {
    options.retryBaseDelayMs = input.retryBaseDelayMs;
  }
  if (input.retryMaxDelayMs !== undefined) {
    options.retryMaxDelayMs = input.retryMaxDelayMs;
  }

  return new OpenAIEmbeddingProvider(options);
}

function hashToUnitVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);

  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 1) {
    const bucket = i % dimensions;
    const byte = bytes[i] ?? 0;
    const signed = i % 2 === 0 ? byte : -byte;
    const current = vector[bucket] ?? 0;
    vector[bucket] = current + signed;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);

  if (!norm) {
    return vector;
  }

  return vector.map((value) => value / norm);
}

function normalizeInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return 0;
  }

  const asSeconds = Number.parseFloat(value);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.round(asSeconds * 1000);
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          break;
        }
        const item = items[index];
        if (!item) {
          continue;
        }
        await worker(item);
      }
    })
  );
}
