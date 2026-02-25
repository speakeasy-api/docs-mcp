import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "@lancedb/lancedb";
import { sha256hex, toEmbeddingInput } from "./embedding.js";
import type { Chunk, EmbedIncrementalOptions, EmbeddingConfig } from "./types.js";

/**
 * Bumped only if toEmbeddingInput() changes in a way that isn't captured
 * by the input text itself (e.g., normalization, encoding).
 */
export const EMBEDDING_FORMAT_VERSION = "1";

const CACHE_VERSION = "1";
const CACHE_DIR_NAME = ".embedding-cache";
const CACHE_TMP_DIR_NAME = ".embedding-cache.tmp";
const CACHE_OLD_DIR_NAME = ".embedding-cache.old";
const CACHE_META_FILE = "cache-meta.json";
const CACHE_TABLE_NAME = "embeddings";

interface CacheMeta {
  cache_version: string;
  format_version: string;
  config_fingerprint: string;
}

export interface CacheEntry {
  fingerprint: string;
  chunk_id: string;
  vector: number[];
}

export interface EmbeddingCache {
  entries: Map<string, CacheEntry>;
}

export interface EmbedIncrementalStats {
  total: number;
  hits: number;
  misses: number;
}

/**
 * Compute a fingerprint for a chunk that captures both the embedding model config
 * and the exact text that would be sent to the model.
 */
export function computeFingerprint(chunk: Chunk, config: EmbeddingConfig): string {
  const input = [
    EMBEDDING_FORMAT_VERSION,
    config.configFingerprint,
    toEmbeddingInput(chunk),
  ].join("\0");
  return sha256hex(input);
}

function cacheDirPath(baseDir: string): string {
  return path.join(baseDir, CACHE_DIR_NAME);
}
function cacheTmpDirPath(baseDir: string): string {
  return path.join(baseDir, CACHE_TMP_DIR_NAME);
}
function cacheOldDirPath(baseDir: string): string {
  return path.join(baseDir, CACHE_OLD_DIR_NAME);
}

/**
 * Remove leftover .tmp and .old directories from interrupted builds.
 */
async function cleanupStaleDirectories(baseDir: string): Promise<void> {
  await rm(cacheTmpDirPath(baseDir), { recursive: true, force: true });
  await rm(cacheOldDirPath(baseDir), { recursive: true, force: true });
}

/**
 * Load the embedding cache from disk.
 * Returns null (with a warning to stderr) if the cache is missing, corrupt, or incompatible.
 */
export async function loadCache(
  baseDir: string,
  currentConfig: EmbeddingConfig
): Promise<EmbeddingCache | null> {
  await cleanupStaleDirectories(baseDir);

  const cacheDir = cacheDirPath(baseDir);
  const metaPath = path.join(cacheDir, CACHE_META_FILE);

  let metaRaw: string;
  try {
    metaRaw = await readFile(metaPath, "utf8");
  } catch {
    // cache-meta.json missing — check if the cache dir itself exists (orphaned LanceDB files)
    try {
      await stat(cacheDir);
      console.warn("warn: embedding cache invalidated: cache-meta.json missing but cache directory exists");
      await rm(cacheDir, { recursive: true, force: true });
    } catch {
      // No cache dir at all — normal first-build case, no warning needed
    }
    return null;
  }

  let meta: CacheMeta;
  try {
    meta = JSON.parse(metaRaw) as CacheMeta;
  } catch {
    console.warn("warn: embedding cache invalidated: corrupt cache-meta.json");
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }

  if (typeof meta.cache_version !== "string" || meta.cache_version.split(".")[0] !== CACHE_VERSION.split(".")[0]) {
    console.warn(`warn: embedding cache invalidated: cache_version mismatch (got ${meta.cache_version}, expected ${CACHE_VERSION})`);
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }

  if (meta.format_version !== EMBEDDING_FORMAT_VERSION) {
    console.warn(`warn: embedding cache invalidated: format_version mismatch (got ${meta.format_version}, expected ${EMBEDDING_FORMAT_VERSION})`);
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }

  if (meta.config_fingerprint !== currentConfig.configFingerprint) {
    console.warn("warn: embedding cache invalidated: config_fingerprint mismatch (provider config changed)");
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }

  try {
    const db = await connect(cacheDir);
    try {
      const tableNames = await db.tableNames();
      if (!tableNames.includes(CACHE_TABLE_NAME)) {
        // Valid meta but no table — could be a zero-chunk build. Return empty cache.
        return { entries: new Map() };
      }

      const table = await db.openTable(CACHE_TABLE_NAME);
      const rows = await table.query().toArray();
      const entries = new Map<string, CacheEntry>();

      // NOTE: This loads all vectors into JS memory as number[] (Float64).
      // For a 50K-chunk corpus at 3072 dims this is ~600MB+ of heap. Acceptable
      // for v1; a streaming/query approach could reduce peak memory later.
      for (const row of rows) {
        const fingerprint = row.fingerprint as string;
        const chunk_id = row.chunk_id as string;
        const vector = Array.from(row.vector as Float32Array | number[]);
        entries.set(fingerprint, { fingerprint, chunk_id, vector });
      }

      table.close();
      return { entries };
    } finally {
      db.close();
    }
  } catch {
    console.warn("warn: embedding cache invalidated: failed to read cache table");
    await rm(cacheDir, { recursive: true, force: true });
    return null;
  }
}

/**
 * Save the embedding cache to disk using the rotate-and-rename pattern
 * for crash safety.
 */
export async function saveCache(
  baseDir: string,
  cache: EmbeddingCache,
  config: EmbeddingConfig
): Promise<void> {
  const tmpDir = cacheTmpDirPath(baseDir);
  const liveDir = cacheDirPath(baseDir);
  const oldDir = cacheOldDirPath(baseDir);

  // Clean up any leftover temp/old dirs
  await rm(tmpDir, { recursive: true, force: true });
  await rm(oldDir, { recursive: true, force: true });

  // Write cache-meta.json
  await mkdir(tmpDir, { recursive: true });
  const meta: CacheMeta = {
    cache_version: CACHE_VERSION,
    format_version: EMBEDDING_FORMAT_VERSION,
    config_fingerprint: config.configFingerprint,
  };
  await writeFile(path.join(tmpDir, CACHE_META_FILE), JSON.stringify(meta, null, 2));

  // Write LanceDB cache table
  const rows = Array.from(cache.entries.values()).map((entry) => ({
    fingerprint: entry.fingerprint,
    chunk_id: entry.chunk_id,
    vector: entry.vector,
  }));

  if (rows.length > 0) {
    const db = await connect(tmpDir);
    try {
      const table = await db.createTable(CACHE_TABLE_NAME, rows, { mode: "overwrite" });
      table.close();
    } finally {
      db.close();
    }
  }

  // Atomic swap: live → old, tmp → live, delete old
  try {
    await rename(liveDir, oldDir);
  } catch {
    // No prior cache — that's fine
  }
  await rename(tmpDir, liveDir);
  await rm(oldDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Embed chunks incrementally: reuse cached vectors for unchanged chunks,
 * only call the provider for misses.
 */
export async function embedChunksIncremental(
  chunks: Chunk[],
  provider: EmbeddingConfig & { embed(texts: string[]): Promise<number[][]> },
  cache: EmbeddingCache | null,
  options?: EmbedIncrementalOptions,
): Promise<{
  vectorsByChunkId: Map<string, number[]>;
  updatedCache: EmbeddingCache;
  stats: EmbedIncrementalStats;
}> {
  const config: EmbeddingConfig = {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    configFingerprint: provider.configFingerprint,
  };

  // Partition chunks into hits and misses
  const fingerprints = chunks.map((chunk) => computeFingerprint(chunk, config));
  const hitIndices: number[] = [];
  const missIndices: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const fp = fingerprints[i]!;
    if (cache?.entries.has(fp)) {
      hitIndices.push(i);
    } else {
      missIndices.push(i);
    }
  }

  // Embed only misses
  const missTexts = missIndices.map((i) => toEmbeddingInput(chunks[i]!));
  const missVectors: number[][] = [];

  const batchSize = options?.batchSize;
  const batchApiThreshold = options?.batchApiThreshold;
  if (missTexts.length > 0 && batchApiThreshold && missTexts.length >= batchApiThreshold) {
    // Send all at once so provider can use Batch API
    missVectors.push(...await provider.embed(missTexts));
  } else if (missTexts.length > 0 && batchSize && batchSize > 0) {
    let embeddedSoFar = 0;
    for (let offset = 0; offset < missTexts.length; offset += batchSize) {
      const batch = missTexts.slice(offset, offset + batchSize);
      const batchVectors = await provider.embed(batch);
      missVectors.push(...batchVectors);
      embeddedSoFar += batch.length;
      options.onProgress?.({
        phase: "embedding",
        completed: hitIndices.length + embeddedSoFar,
        total: chunks.length,
        cached: hitIndices.length,
      });
    }
  } else if (missTexts.length > 0) {
    missVectors.push(...await provider.embed(missTexts));
  }

  if (missVectors.length !== missTexts.length) {
    throw new Error(
      `Embedding provider returned ${missVectors.length} vectors for ${missTexts.length} chunks`
    );
  }

  // Merge results
  const vectorsByChunkId = new Map<string, number[]>();
  const newEntries = new Map<string, CacheEntry>();

  // Cache hits
  for (const i of hitIndices) {
    const fp = fingerprints[i]!;
    const chunk = chunks[i]!;
    const entry = cache!.entries.get(fp)!;
    vectorsByChunkId.set(chunk.chunk_id, entry.vector);
    newEntries.set(fp, entry);
  }

  // Cache misses (freshly embedded)
  for (let j = 0; j < missIndices.length; j++) {
    const i = missIndices[j]!;
    const fp = fingerprints[i]!;
    const chunk = chunks[i]!;
    const vector = missVectors[j]!;
    vectorsByChunkId.set(chunk.chunk_id, vector);
    newEntries.set(fp, { fingerprint: fp, chunk_id: chunk.chunk_id, vector });
  }

  return {
    vectorsByChunkId,
    updatedCache: { entries: newEntries },
    stats: {
      total: chunks.length,
      hits: hitIndices.length,
      misses: missIndices.length,
    },
  };
}
