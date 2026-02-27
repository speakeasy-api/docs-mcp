import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeFingerprint,
  embedChunksIncremental,
  loadCache,
  saveCache,
} from "../src/embedding-cache.js";
import { HashEmbeddingProvider, toEmbeddingInput } from "../src/embedding.js";
import type { Chunk, EmbeddingConfig } from "../src/types.js";

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunk_id: "test.md#section",
    filepath: "test.md",
    heading: "Section",
    heading_level: 2,
    content: "# Section\n\nHello world",
    content_text: "Hello world",
    breadcrumb: "test.md > Section",
    chunk_index: 0,
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "hash",
    model: "hash-v1",
    dimensions: 8,
    configFingerprint: "test-fingerprint-abc123",
    ...overrides,
  };
}

describe("computeFingerprint", () => {
  it("is deterministic for the same chunk and config", () => {
    const chunk = makeChunk();
    const config = makeConfig();
    const fp1 = computeFingerprint(chunk, config);
    const fp2 = computeFingerprint(chunk, config);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when content_text changes", () => {
    const config = makeConfig();
    const chunk1 = makeChunk({ content_text: "Hello world" });
    const chunk2 = makeChunk({ content_text: "Hello world updated" });
    expect(computeFingerprint(chunk1, config)).not.toBe(computeFingerprint(chunk2, config));
  });

  it("changes when breadcrumb changes", () => {
    const config = makeConfig();
    const chunk1 = makeChunk({ breadcrumb: "test.md > Section" });
    const chunk2 = makeChunk({ breadcrumb: "test.md > Renamed Section" });
    expect(computeFingerprint(chunk1, config)).not.toBe(computeFingerprint(chunk2, config));
  });

  it("changes when configFingerprint changes", () => {
    const chunk = makeChunk();
    const config1 = makeConfig({ configFingerprint: "config-a" });
    const config2 = makeConfig({ configFingerprint: "config-b" });
    expect(computeFingerprint(chunk, config1)).not.toBe(computeFingerprint(chunk, config2));
  });

  it("uses toEmbeddingInput for text construction (null-byte safety)", () => {
    const chunk = makeChunk({ content_text: "a\0b" });
    const config = makeConfig();
    // Should not throw and should produce a valid fingerprint
    const fp = computeFingerprint(chunk, config);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different chunk_id with same content produces same fingerprint", () => {
    const config = makeConfig();
    const chunk1 = makeChunk({ chunk_id: "a.md#section" });
    const chunk2 = makeChunk({ chunk_id: "b.md#section" });
    // chunk_id is NOT part of the fingerprint — content is
    expect(computeFingerprint(chunk1, config)).toBe(computeFingerprint(chunk2, config));
  });
});

describe("loadCache / saveCache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-cache-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no cache exists", async () => {
    const config = makeConfig();
    const result = await loadCache(tmpDir, config);
    expect(result).toBeNull();
  });

  it("round-trips a cache through save and load", async () => {
    const config = makeConfig();
    const cache = {
      entries: new Map([
        [
          "fp1",
          {
            fingerprint: "fp1",
            chunk_id: "a.md#sec",
            vector: [1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
        [
          "fp2",
          {
            fingerprint: "fp2",
            chunk_id: "b.md#sec",
            vector: [8, 7, 6, 5, 4, 3, 2, 1],
          },
        ],
      ]),
    };

    await saveCache(tmpDir, cache, config);
    const loaded = await loadCache(tmpDir, config);

    expect(loaded).not.toBeNull();
    expect(loaded!.entries.size).toBe(2);

    const entry1 = loaded!.entries.get("fp1");
    expect(entry1).toBeDefined();
    expect(entry1!.chunk_id).toBe("a.md#sec");
    expect(entry1!.vector).toHaveLength(8);
    // Float32 precision: compare approximately
    for (let i = 0; i < 8; i++) {
      expect(entry1!.vector[i]).toBeCloseTo(cache.entries.get("fp1")!.vector[i]!, 5);
    }
  });

  it("invalidates cache on config_fingerprint mismatch", async () => {
    const config1 = makeConfig({ configFingerprint: "config-a" });
    const config2 = makeConfig({ configFingerprint: "config-b" });

    const cache = {
      entries: new Map([
        [
          "fp1",
          {
            fingerprint: "fp1",
            chunk_id: "a.md#sec",
            vector: [1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
      ]),
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await saveCache(tmpDir, cache, config1);
    const loaded = await loadCache(tmpDir, config2);

    expect(loaded).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("config_fingerprint mismatch"));

    warnSpy.mockRestore();
  });

  it("invalidates cache on corrupt cache-meta.json", async () => {
    const cacheDir = path.join(tmpDir, ".embedding-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "cache-meta.json"), "not valid json{{{");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = makeConfig();
    const loaded = await loadCache(tmpDir, config);

    expect(loaded).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt cache-meta.json"));

    warnSpy.mockRestore();
  });

  it("invalidates cache on format_version mismatch", async () => {
    const config = makeConfig();
    const cacheDir = path.join(tmpDir, ".embedding-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "cache-meta.json"),
      JSON.stringify({
        cache_version: "1",
        format_version: "999",
        config_fingerprint: config.configFingerprint,
      }),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadCache(tmpDir, config);

    expect(loaded).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("format_version mismatch"));

    warnSpy.mockRestore();
  });

  it("cleans up stale .tmp and .old directories", async () => {
    const config = makeConfig();
    // Create stale directories
    await mkdir(path.join(tmpDir, ".embedding-cache.tmp"), { recursive: true });
    await writeFile(path.join(tmpDir, ".embedding-cache.tmp", "stale"), "stale");
    await mkdir(path.join(tmpDir, ".embedding-cache.old"), { recursive: true });
    await writeFile(path.join(tmpDir, ".embedding-cache.old", "stale"), "stale");

    // loadCache should clean them up
    const loaded = await loadCache(tmpDir, config);
    expect(loaded).toBeNull();

    // Verify stale dirs are gone
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(tmpDir, ".embedding-cache.tmp"))).rejects.toThrow();
    await expect(stat(path.join(tmpDir, ".embedding-cache.old"))).rejects.toThrow();
  });

  it("atomic write survives overwriting a previous cache", async () => {
    const config = makeConfig();
    const cache1 = {
      entries: new Map([
        [
          "fp1",
          {
            fingerprint: "fp1",
            chunk_id: "a.md#sec",
            vector: [1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
      ]),
    };
    const cache2 = {
      entries: new Map([
        [
          "fp2",
          {
            fingerprint: "fp2",
            chunk_id: "b.md#sec",
            vector: [8, 7, 6, 5, 4, 3, 2, 1],
          },
        ],
      ]),
    };

    await saveCache(tmpDir, cache1, config);
    await saveCache(tmpDir, cache2, config);

    const loaded = await loadCache(tmpDir, config);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries.size).toBe(1);
    expect(loaded!.entries.has("fp2")).toBe(true);
    expect(loaded!.entries.has("fp1")).toBe(false);
  });

  it("handles empty cache (zero entries) without warning on reload", async () => {
    const config = makeConfig();
    const emptyCache = { entries: new Map() };

    await saveCache(tmpDir, emptyCache, config);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadCache(tmpDir, config);

    expect(loaded).not.toBeNull();
    expect(loaded!.entries.size).toBe(0);
    // Should NOT emit any invalidation warning
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe("embedChunksIncremental", () => {
  it("embeds all chunks on cold cache (null)", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({ chunk_id: "a.md#s1", content_text: "hello" }),
      makeChunk({ chunk_id: "b.md#s2", content_text: "world" }),
    ];

    const embedSpy = vi.spyOn(provider, "embed");

    const result = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );

    expect(result.stats.total).toBe(2);
    expect(result.stats.hits).toBe(0);
    expect(result.stats.misses).toBe(2);
    expect(result.vectorsByChunkId.size).toBe(2);
    expect(result.updatedCache.entries.size).toBe(2);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledWith(chunks.map((c) => toEmbeddingInput(c)));
  });

  it("reuses cached vectors for unchanged chunks", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a.md > s1",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world",
        breadcrumb: "b.md > s2",
      }),
    ];

    // First pass: cold cache
    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );
    expect(result1.stats.misses).toBe(2);

    // Second pass: warm cache, no changes
    const embedSpy = vi.spyOn(provider, "embed");
    const result2 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      result1.updatedCache,
    );

    expect(result2.stats.total).toBe(2);
    expect(result2.stats.hits).toBe(2);
    expect(result2.stats.misses).toBe(0);
    // embed() should not be called when there are 0 misses
    expect(embedSpy).not.toHaveBeenCalled();

    // Vectors should be equivalent
    for (const [chunkId, vec] of result1.vectorsByChunkId) {
      const cached = result2.vectorsByChunkId.get(chunkId);
      expect(cached).toBeDefined();
      for (let i = 0; i < vec.length; i++) {
        expect(cached![i]).toBeCloseTo(vec[i]!, 5);
      }
    }
  });

  it("re-embeds only changed chunks", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a.md > s1",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world",
        breadcrumb: "b.md > s2",
      }),
    ];

    // First pass: cold cache
    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );

    // Modify one chunk's content
    const modifiedChunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a.md > s1",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world updated",
        breadcrumb: "b.md > s2",
      }),
    ];

    const embedSpy = vi.spyOn(provider, "embed");
    const result2 = await embedChunksIncremental(
      modifiedChunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      result1.updatedCache,
    );

    expect(result2.stats.total).toBe(2);
    expect(result2.stats.hits).toBe(1);
    expect(result2.stats.misses).toBe(1);
    // Only the modified chunk's text should be sent
    expect(embedSpy).toHaveBeenCalledWith([toEmbeddingInput(modifiedChunks[1]!)]);
  });

  it("prunes deleted chunks from the updated cache", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a.md > s1",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world",
        breadcrumb: "b.md > s2",
      }),
    ];

    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );
    expect(result1.updatedCache.entries.size).toBe(2);

    // Second build with only one chunk
    const result2 = await embedChunksIncremental(
      [chunks[0]!],
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      result1.updatedCache,
    );
    // Updated cache should only contain the surviving chunk
    expect(result2.updatedCache.entries.size).toBe(1);
    expect(result2.stats.hits).toBe(1);
    expect(result2.stats.misses).toBe(0);
  });
});

describe("embedChunksIncremental with batchSize and onProgress", () => {
  it("calls onProgress once per batch with correct counts", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "alpha",
        breadcrumb: "a",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "bravo",
        breadcrumb: "b",
      }),
      makeChunk({
        chunk_id: "c.md#s3",
        content_text: "charlie",
        breadcrumb: "c",
      }),
      makeChunk({
        chunk_id: "d.md#s4",
        content_text: "delta",
        breadcrumb: "d",
      }),
      makeChunk({ chunk_id: "e.md#s5", content_text: "echo", breadcrumb: "e" }),
    ];

    const events: Array<{ completed: number; total: number; cached: number }> = [];
    const result = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
      {
        batchSize: 2,
        onProgress: (event) => {
          events.push({
            completed: event.completed,
            total: event.total,
            cached: event.cached,
          });
        },
      },
    );

    expect(result.stats.total).toBe(5);
    expect(result.stats.misses).toBe(5);
    // 5 misses with batchSize=2 → 3 batches (2, 2, 1)
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ completed: 2, total: 5, cached: 0 });
    expect(events[1]).toEqual({ completed: 4, total: 5, cached: 0 });
    expect(events[2]).toEqual({ completed: 5, total: 5, cached: 0 });
  });

  it("splits embed calls into expected number of batches", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const embedSpy = vi.spyOn(provider, "embed");
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "alpha",
        breadcrumb: "a",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "bravo",
        breadcrumb: "b",
      }),
      makeChunk({
        chunk_id: "c.md#s3",
        content_text: "charlie",
        breadcrumb: "c",
      }),
    ];

    await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
      { batchSize: 2 },
    );

    // 3 misses with batchSize=2 → 2 embed calls
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it("does not call onProgress when all chunks are cached", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a",
      }),
    ];

    // First pass: cold cache
    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );

    // Second pass: warm cache
    const events: unknown[] = [];
    const result2 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      result1.updatedCache,
      {
        batchSize: 1,
        onProgress: (event) => {
          events.push(event);
        },
      },
    );

    expect(result2.stats.hits).toBe(1);
    expect(result2.stats.misses).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("reports correct cached count when mixing hits and misses", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const chunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world",
        breadcrumb: "b",
      }),
    ];

    // First pass: cold cache
    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );

    // Second pass: modify one chunk
    const modifiedChunks = [
      makeChunk({
        chunk_id: "a.md#s1",
        content_text: "hello",
        breadcrumb: "a",
      }),
      makeChunk({
        chunk_id: "b.md#s2",
        content_text: "world updated",
        breadcrumb: "b",
      }),
    ];

    const events: Array<{ completed: number; total: number; cached: number }> = [];
    await embedChunksIncremental(
      modifiedChunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      result1.updatedCache,
      {
        batchSize: 10,
        onProgress: (event) => {
          events.push({
            completed: event.completed,
            total: event.total,
            cached: event.cached,
          });
        },
      },
    );

    // 1 hit, 1 miss → 1 batch → 1 progress event
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ completed: 2, total: 2, cached: 1 });
  });
});

describe("embedChunksIncremental with batchApiThreshold", () => {
  it("sends all texts in one embed() call when missCount >= batchApiThreshold", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const embedSpy = vi.spyOn(provider, "embed");
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({
        chunk_id: `f${i}.md#s`,
        content_text: `text-${i}`,
        breadcrumb: `f${i}`,
      }),
    );

    const result = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
      { batchSize: 2, batchApiThreshold: 5 },
    );

    expect(result.stats.misses).toBe(5);
    // With batchApiThreshold=5, all 5 misses should be sent in a single call
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy.mock.calls[0]![0]).toHaveLength(5);
  });

  it("uses standard batching when missCount < batchApiThreshold", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const embedSpy = vi.spyOn(provider, "embed");
    const chunks = Array.from({ length: 3 }, (_, i) =>
      makeChunk({
        chunk_id: `f${i}.md#s`,
        content_text: `text-${i}`,
        breadcrumb: `f${i}`,
      }),
    );

    const result = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
      { batchSize: 2, batchApiThreshold: 5 },
    );

    expect(result.stats.misses).toBe(3);
    // 3 misses < threshold of 5, so standard batching with batchSize=2 → 2 calls
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });
});

describe("end-to-end: save → load → incremental", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-e2e-cache-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full build → modify one chunk → incremental build re-embeds only changed chunk", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const config: EmbeddingConfig = {
      provider: provider.name,
      model: provider.model,
      dimensions: provider.dimensions,
      configFingerprint: provider.configFingerprint,
    };

    const chunks = [
      makeChunk({
        chunk_id: "a.md#intro",
        content_text: "Introduction text",
        breadcrumb: "a.md > Intro",
      }),
      makeChunk({
        chunk_id: "a.md#setup",
        content_text: "Setup instructions",
        breadcrumb: "a.md > Setup",
      }),
      makeChunk({
        chunk_id: "b.md#api",
        content_text: "API reference",
        breadcrumb: "b.md > API",
      }),
    ];

    // First build: cold
    const result1 = await embedChunksIncremental(
      chunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      null,
    );
    expect(result1.stats.misses).toBe(3);
    await saveCache(tmpDir, result1.updatedCache, config);

    // Load cache and do incremental build with modified chunk
    const loaded = await loadCache(tmpDir, config);
    expect(loaded).not.toBeNull();

    const modifiedChunks = [
      makeChunk({
        chunk_id: "a.md#intro",
        content_text: "Introduction text",
        breadcrumb: "a.md > Intro",
      }),
      makeChunk({
        chunk_id: "a.md#setup",
        content_text: "Updated setup instructions",
        breadcrumb: "a.md > Setup",
      }),
      makeChunk({
        chunk_id: "b.md#api",
        content_text: "API reference",
        breadcrumb: "b.md > API",
      }),
    ];

    const result2 = await embedChunksIncremental(
      modifiedChunks,
      {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        configFingerprint: provider.configFingerprint,
        embed: (texts: string[]) => provider.embed(texts),
      },
      loaded,
    );

    expect(result2.stats.hits).toBe(2);
    expect(result2.stats.misses).toBe(1);
    expect(result2.vectorsByChunkId.size).toBe(3);

    // Save updated cache and verify it can be reloaded
    await saveCache(tmpDir, result2.updatedCache, config);
    const reloaded = await loadCache(tmpDir, config);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.entries.size).toBe(3);
  });
});
