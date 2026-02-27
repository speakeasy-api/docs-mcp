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

export interface BatchProgressEvent {
  phase: "batch-uploading" | "batch-polling" | "batch-downloading";
  message: string;
  /** Structured polling data — present when phase is "batch-polling" and counts are available. */
  counts?: { completed: number; total: number; failed: number };
  elapsedSec?: number;
  pollRemainingSec?: number;
  /** Estimated seconds remaining. Undefined until enough data points. */
  etaSec?: number;
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  batchApiThreshold?: number;
  /** Name stored in batch metadata for identification and resume scoping. */
  batchName?: string;
  baseUrl?: string;
  concurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  onBatchProgress?: (event: BatchProgressEvent) => void;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = "none";
  readonly model = "none";
  readonly dimensions = 0;
  readonly costPerMillionTokens = 0;
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
  readonly costPerMillionTokens = 0;
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

/** Known pricing in USD per 1M input tokens for OpenAI embedding models. */
const OPENAI_COST_PER_M_TOKENS: Record<string, number> = {
  "text-embedding-3-large": 0.13,
  "text-embedding-3-small": 0.02,
  "text-embedding-ada-002": 0.1,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  readonly costPerMillionTokens: number;
  readonly configFingerprint: string;
  readonly batchApiThreshold: number;

  private readonly apiKey: string;
  readonly batchSize: number;
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly batchName: string;
  private readonly onBatchProgress: ((event: BatchProgressEvent) => void) | undefined;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OpenAIEmbeddingProvider requires a non-empty apiKey");
    }

    this.apiKey = options.apiKey;
    this.model = options.model ?? "text-embedding-3-large";
    this.costPerMillionTokens = OPENAI_COST_PER_M_TOKENS[this.model] ?? 0;
    this.dimensions = options.dimensions ?? 3072;
    this.batchSize = options.batchSize ?? 128;
    this.batchApiThreshold = options.batchApiThreshold ?? 2500;
    this.batchName = options.batchName ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.concurrency = normalizeInt(options.concurrency, 4, 1, 32);
    this.maxRetries = normalizeInt(options.maxRetries, 3, 0, 10);
    this.retryBaseDelayMs = normalizeInt(options.retryBaseDelayMs, 500, 50, 60_000);
    this.retryMaxDelayMs = normalizeInt(options.retryMaxDelayMs, 10_000, 100, 120_000);
    this.onBatchProgress = options.onBatchProgress;
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

    if (this.batchApiThreshold > 0 && texts.length >= this.batchApiThreshold) {
      return this.embedViaBatchApi(texts);
    }

    const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(texts.length);
    const batches: Array<{ offset: number; values: string[] }> = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push({
        offset: i,
        values: texts.slice(i, i + this.batchSize),
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
        const source = text.match(/^Context: (.+)\n/)?.[1] ?? "unknown";
        console.warn(
          `[docs-mcp] Embedding input truncated from ${text.length} to ${DEFAULT_MAX_INPUT_CHARS} characters (source: ${source}). ` +
            `Consider lowering max_chunk_size in your chunking strategy to avoid content loss.`,
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
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: truncated,
          dimensions: this.dimensions,
        }),
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
            `OpenAI embeddings response size mismatch: expected ${batch.length}, got ${ordered.length}`,
          );
        }

        return ordered.map((item) => item.embedding);
      }

      const body = await response.text();
      if (!isRetryableStatus(response.status) || attempt >= this.maxRetries) {
        throw new Error(
          `OpenAI embeddings request failed (${response.status}): ${body.slice(0, 500)}`,
        );
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const backoffMs = Math.min(
        this.retryMaxDelayMs,
        Math.max(
          retryAfterMs,
          this.retryBaseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250),
        ),
      );

      await sleep(backoffMs);
      attempt += 1;
    }
  }

  private buildBatchJsonl(texts: string[]): string {
    const lines: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      let text = texts[i]!;
      if (text.length > DEFAULT_MAX_INPUT_CHARS) {
        text = text.slice(0, DEFAULT_MAX_INPUT_CHARS);
      }
      lines.push(
        JSON.stringify({
          custom_id: `req-${i}`,
          method: "POST",
          url: "/v1/embeddings",
          body: {
            model: this.model,
            input: text,
            dimensions: this.dimensions,
          },
        }),
      );
    }
    return lines.join("\n");
  }

  private async uploadBatchFile(jsonl: string): Promise<string> {
    const blob = new Blob([jsonl], { type: "application/jsonl" });
    const formData = new FormData();
    formData.append("purpose", "batch");
    formData.append("file", blob, "batch-embeddings.jsonl");

    const response = await fetch(`${this.baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI file upload failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as { id: string };
    return payload.id;
  }

  private async createBatch(fileId: string, contentSha: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/batches`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input_file_id: fileId,
        endpoint: "/v1/embeddings",
        completion_window: "24h",
        metadata: {
          ...(this.batchName ? { batch_name: this.batchName } : {}),
          content_sha: contentSha,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI batch creation failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as { id: string };
    return payload.id;
  }

  /**
   * Search recent OpenAI batches for one whose metadata.content_sha matches,
   * indicating the same embedding inputs were already submitted.
   * Returns the batch if found in a usable state; null otherwise.
   */
  private async findExistingBatch(contentSha: string): Promise<{
    id: string;
    status: string;
    output_file_id?: string;
  } | null> {
    try {
      const response = await fetch(`${this.baseUrl}/batches?limit=100`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        return null; // Non-critical — fall through to creating a new batch
      }

      const payload = (await response.json()) as {
        data: Array<{
          id: string;
          status: string;
          output_file_id?: string;
          metadata?: Record<string, string>;
        }>;
      };

      for (const batch of payload.data) {
        if (
          this.batchName &&
          batch.metadata?.batch_name &&
          batch.metadata.batch_name !== this.batchName
        )
          continue;
        if (batch.metadata?.content_sha !== contentSha) continue;

        // Skip terminal failure states — we'll create a new batch
        if (
          batch.status === "failed" ||
          batch.status === "expired" ||
          batch.status === "cancelled"
        ) {
          continue;
        }

        return {
          id: batch.id,
          status: batch.status,
          ...(batch.output_file_id ? { output_file_id: batch.output_file_id } : {}),
        };
      }
    } catch {
      // Network error listing batches — non-critical
    }

    return null;
  }

  private async pollBatchUntilComplete(batchId: string): Promise<string> {
    const maxWaitMs = 2 * 60 * 60 * 1000; // 2 hours
    const intervals = [10_000, 10_000, 10_000, 30_000, 30_000, 60_000]; // escalating
    const startTime = Date.now();
    let pollIndex = 0;
    let firstProgressTime: number | undefined;
    let firstProgressCompleted: number | undefined;

    while (true) {
      const interval = intervals[Math.min(pollIndex, intervals.length - 1)]!;

      const response = await fetch(`${this.baseUrl}/batches/${batchId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI batch poll failed (${response.status}): ${body.slice(0, 500)}`);
      }

      const batch = (await response.json()) as {
        status: string;
        output_file_id?: string;
        request_counts?: { total: number; completed: number; failed: number };
      };

      if (batch.status === "completed") {
        if (!batch.output_file_id) {
          throw new Error("OpenAI batch completed but no output_file_id returned");
        }
        return batch.output_file_id;
      }

      if (batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled") {
        throw new Error(`OpenAI batch ${batch.status}`);
      }

      if (Date.now() - startTime >= maxWaitMs) {
        throw new Error(`OpenAI batch timed out after ${maxWaitMs / 1000}s`);
      }

      const intervalSec = interval / 1000;
      const counts = batch.request_counts;

      // Track first time we see progress to compute ETA
      if (counts && counts.completed > 0 && firstProgressTime === undefined) {
        firstProgressTime = Date.now();
        firstProgressCompleted = counts.completed;
      }

      let etaSec: number | undefined;
      if (
        firstProgressTime !== undefined &&
        firstProgressCompleted !== undefined &&
        counts &&
        counts.completed > firstProgressCompleted
      ) {
        const elapsedSinceFirst = (Date.now() - firstProgressTime) / 1000;
        const completedSinceFirst = counts.completed - firstProgressCompleted;
        const rate = completedSinceFirst / elapsedSinceFirst;
        etaSec = Math.round((counts.total - counts.completed) / rate);
      }

      let progressSuffix = "";
      if (counts) {
        const pct = ((counts.completed / counts.total) * 100).toFixed(1);
        const eta = etaSec !== undefined ? `, ETA ~${formatDuration(etaSec)}` : "";
        const failed = counts.failed > 0 ? `, ${counts.failed} failed` : "";
        progressSuffix = ` — ${counts.completed}/${counts.total} (${pct}%)${failed}${eta}`;
      }

      for (let remaining = intervalSec; remaining > 0; remaining--) {
        const now = Math.round((Date.now() - startTime) / 1000);
        this.onBatchProgress?.({
          phase: "batch-polling",
          message: `Batch API: Elapsed=${now}s. Next poll in ${remaining}s${progressSuffix}`,
          ...(counts ? { counts } : {}),
          elapsedSec: now,
          pollRemainingSec: remaining,
          ...(etaSec !== undefined ? { etaSec } : {}),
        });
        await sleep(1000);
      }
      pollIndex++;
    }
  }

  private async downloadBatchResults(
    outputFileId: string,
    expectedCount: number,
  ): Promise<number[][]> {
    this.onBatchProgress?.({
      phase: "batch-downloading",
      message: "Downloading results...",
    });

    const response = await fetch(`${this.baseUrl}/files/${outputFileId}/content`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI batch results download failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const text = await response.text();
    const vectors = new Array<number[] | undefined>(expectedCount);

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        custom_id: string;
        response: {
          body: {
            data: Array<{ embedding: number[] }>;
          };
        };
      };
      const index = Number.parseInt(row.custom_id.replace("req-", ""), 10);
      vectors[index] = row.response.body.data[0]!.embedding;
    }

    if (vectors.some((v) => v === undefined)) {
      throw new Error("OpenAI batch results missing one or more vectors");
    }

    return vectors as number[][];
  }

  private async embedViaBatchApi(texts: string[]): Promise<number[][]> {
    const jsonl = this.buildBatchJsonl(texts);
    const contentSha = sha256hex(jsonl);
    const sizeMB = (new TextEncoder().encode(jsonl).byteLength / (1024 * 1024)).toFixed(1);

    // Check if an identical batch already exists on OpenAI (e.g. from a cancelled run)
    const existing = await this.findExistingBatch(contentSha);
    if (existing) {
      if (existing.status === "completed" && existing.output_file_id) {
        this.onBatchProgress?.({
          phase: "batch-downloading",
          message: `Found completed batch ${existing.id} with matching content — downloading results...`,
        });
        return this.downloadBatchResults(existing.output_file_id, texts.length);
      }

      // Still in progress — resume polling
      this.onBatchProgress?.({
        phase: "batch-polling",
        message: `Resuming existing batch ${existing.id} (status: ${existing.status})`,
      });
      const outputFileId = await this.pollBatchUntilComplete(existing.id);
      return this.downloadBatchResults(outputFileId, texts.length);
    }

    this.onBatchProgress?.({
      phase: "batch-uploading",
      message: `Embedding ${texts.length} chunks (>= ${this.batchApiThreshold} threshold): using batch API\nUploading batch file: ${sizeMB}MB...`,
    });

    const fileId = await this.uploadBatchFile(jsonl);
    const batchId = await this.createBatch(fileId, contentSha);
    const outputFileId = await this.pollBatchUntilComplete(batchId);
    return this.downloadBatchResults(outputFileId, texts.length);
  }
}

export function createEmbeddingProvider(input: {
  provider: "none" | "hash" | "openai";
  dimensions?: number;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  batchApiThreshold?: number;
  batchName?: string;
  concurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  onBatchProgress?: (event: BatchProgressEvent) => void;
}): EmbeddingProvider {
  if (input.provider !== "none" && input.provider !== "hash" && input.provider !== "openai") {
    throw new Error(
      `unsupported embedding provider '${String(input.provider)}'. Expected one of: none, hash, openai`,
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
      `${input.provider} embedding provider requires --embedding-api-key or OPENAI_API_KEY`,
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
  if (input.batchApiThreshold !== undefined) {
    options.batchApiThreshold = input.batchApiThreshold;
  }
  if (input.batchName !== undefined) {
    options.batchName = input.batchName;
  }
  if (input.onBatchProgress !== undefined) {
    options.onBatchProgress = input.onBatchProgress;
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
  max: number,
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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
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
    }),
  );
}
