import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeChunkFingerprint, loadChunksFromPreviousIndex } from "../src/chunk-cache.js";
import { buildLanceDbIndex } from "../src/lancedb.js";
import type { Chunk, ChunkingStrategy } from "../src/types.js";

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

describe("computeChunkFingerprint", () => {
  it("is deterministic for the same inputs", () => {
    const strategy: ChunkingStrategy = { chunk_by: "h2" };
    const metadata = { language: "typescript" };
    const markdown = "# Hello\n\nWorld";

    const fp1 = computeChunkFingerprint(markdown, strategy, metadata);
    const fp2 = computeChunkFingerprint(markdown, strategy, metadata);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when markdown changes", () => {
    const strategy: ChunkingStrategy = { chunk_by: "h2" };
    const metadata = { language: "typescript" };

    const fp1 = computeChunkFingerprint("# Hello", strategy, metadata);
    const fp2 = computeChunkFingerprint("# Hello Updated", strategy, metadata);
    expect(fp1).not.toBe(fp2);
  });

  it("changes when strategy changes", () => {
    const metadata = { language: "typescript" };
    const markdown = "# Hello\n\nWorld";

    const fp1 = computeChunkFingerprint(markdown, { chunk_by: "h2" }, metadata);
    const fp2 = computeChunkFingerprint(markdown, { chunk_by: "h3" }, metadata);
    expect(fp1).not.toBe(fp2);
  });

  it("changes when metadata changes", () => {
    const strategy: ChunkingStrategy = { chunk_by: "h2" };
    const markdown = "# Hello\n\nWorld";

    const fp1 = computeChunkFingerprint(markdown, strategy, {
      language: "typescript",
    });
    const fp2 = computeChunkFingerprint(markdown, strategy, {
      language: "python",
    });
    expect(fp1).not.toBe(fp2);
  });
});

describe("loadChunksFromPreviousIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-chunk-cache-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing DB", async () => {
    const result = await loadChunksFromPreviousIndex(path.join(tmpDir, "nonexistent-db"));
    expect(result).toBeNull();
  });

  it("returns null when file_fingerprint column is missing (old-format index)", async () => {
    // Build an index without fingerprints
    const chunks: Chunk[] = [makeChunk({ chunk_id: "a.md#intro", filepath: "a.md" })];

    const dbPath = path.join(tmpDir, ".lancedb");
    await buildLanceDbIndex({ dbPath, chunks });

    const result = await loadChunksFromPreviousIndex(dbPath);
    expect(result).toBeNull();
  });

  it("round-trips: build with fingerprints, load back, fingerprints match and getChunks returns correct data", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "a.md#intro",
        filepath: "a.md",
        heading: "Intro",
        heading_level: 2,
        content: "# Intro\n\nIntroduction text",
        content_text: "Introduction text",
        breadcrumb: "a.md > Intro",
        chunk_index: 0,
        metadata: { language: "typescript" },
      }),
      makeChunk({
        chunk_id: "a.md#setup",
        filepath: "a.md",
        heading: "Setup",
        heading_level: 2,
        content: "# Setup\n\nSetup instructions",
        content_text: "Setup instructions",
        breadcrumb: "a.md > Setup",
        chunk_index: 1,
        metadata: { language: "typescript" },
      }),
      makeChunk({
        chunk_id: "b.md#api",
        filepath: "b.md",
        heading: "API",
        heading_level: 2,
        content: "# API\n\nAPI reference",
        content_text: "API reference",
        breadcrumb: "b.md > API",
        chunk_index: 0,
        metadata: { language: "python" },
      }),
    ];

    const fileFingerprints: Record<string, string> = {
      "a.md": "fp-aaa",
      "b.md": "fp-bbb",
    };

    const dbPath = path.join(tmpDir, ".lancedb");
    await buildLanceDbIndex({ dbPath, chunks, fileFingerprints });

    const reader = await loadChunksFromPreviousIndex(dbPath);
    expect(reader).not.toBeNull();

    // Check fingerprints
    expect(reader!.fingerprints.get("a.md")).toBe("fp-aaa");
    expect(reader!.fingerprints.get("b.md")).toBe("fp-bbb");

    // Check getChunks for file a.md
    const aChunks = await reader!.getChunks("a.md");
    expect(aChunks).toHaveLength(2);
    expect(aChunks[0]!.chunk_id).toBe("a.md#intro");
    expect(aChunks[0]!.content_text).toBe("Introduction text");
    expect(aChunks[0]!.metadata).toEqual({ language: "typescript" });
    expect(aChunks[1]!.chunk_id).toBe("a.md#setup");
    expect(aChunks[1]!.chunk_index).toBe(1);

    // Check getChunks for file b.md
    const bChunks = await reader!.getChunks("b.md");
    expect(bChunks).toHaveLength(1);
    expect(bChunks[0]!.chunk_id).toBe("b.md#api");
    expect(bChunks[0]!.metadata).toEqual({ language: "python" });

    // Check getChunks for non-existent file
    const noChunks = await reader!.getChunks("nonexistent.md");
    expect(noChunks).toHaveLength(0);

    reader!.close();
  });
});
