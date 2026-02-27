import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLanceDbIndex, LanceDbSearchEngine } from "../src/lancedb.js";
import type { Chunk, EmbeddingProvider } from "../src/types.js";
import { buildChunks } from "../src/chunking.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LanceDbSearchEngine", () => {
  it("supports filter pushdown and auto-include behavior", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/ts.md#retry",
        filepath: "docs/ts.md",
        heading: "Retry",
        heading_level: 2,
        content: "TypeScript retry docs",
        content_text: "TypeScript retry docs",
        breadcrumb: "docs/ts.md > Retry",
        chunk_index: 0,
        metadata: { language: "typescript", scope: "sdk-specific" },
      },
      {
        chunk_id: "docs/global.md#retry-guide",
        filepath: "docs/global.md",
        heading: "Retry Guide",
        heading_level: 2,
        content: "Global retry guidance",
        content_text: "Global retry guidance",
        breadcrumb: "docs/global.md > Retry Guide",
        chunk_index: 0,
        metadata: { scope: "global-guide" },
      },
      {
        chunk_id: "docs/legacy.md#retry",
        filepath: "docs/legacy.md",
        heading: "Retry",
        heading_level: 2,
        content: "Legacy retry docs",
        content_text: "Legacy retry docs",
        breadcrumb: "docs/legacy.md > Retry",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/legacy-py.md#retry",
        filepath: "docs/legacy-py.md",
        heading: "Retry",
        heading_level: 2,
        content: "Legacy Python retry docs",
        content_text: "Legacy Python retry docs",
        breadcrumb: "docs/legacy-py.md > Retry",
        chunk_index: 0,
        metadata: { language: "python" },
      },
    ];

    await buildLanceDbIndex({
      dbPath: dir,
      chunks,
      metadataKeys: ["language", "scope"],
    });

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: ["language", "scope"],
    });

    const result = await engine.search({
      query: "retry",
      limit: 10,
      filters: { language: "typescript" },
    });

    expect(result.hits.map((hit) => hit.chunk_id).sort()).toEqual([
      "docs/global.md#retry-guide",
      "docs/legacy.md#retry",
      "docs/ts.md#retry",
    ]);
    expect(result.hits.map((hit) => hit.chunk_id)).not.toContain("docs/legacy-py.md#retry");
  });

  it("blends match and phrase queries to prioritize contiguous terms", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/a.md#one",
        filepath: "docs/a.md",
        heading: "One",
        heading_level: 2,
        content: "Retry backoff strategy for APIs",
        content_text: "Retry backoff strategy for APIs",
        breadcrumb: "docs/a.md > One",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/b.md#two",
        filepath: "docs/b.md",
        heading: "Two",
        heading_level: 2,
        content: "Retry and then maybe later do backoff",
        content_text: "Retry and then maybe later do backoff",
        breadcrumb: "docs/b.md > Two",
        chunk_index: 0,
        metadata: {},
      },
    ];

    await buildLanceDbIndex({
      dbPath: dir,
      chunks,
    });

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
      proximityWeight: 2,
    });

    const result = await engine.search({
      query: "retry backoff",
      limit: 10,
      filters: {},
    });

    expect(result.hits[0]?.chunk_id).toBe("docs/a.md#one");
  });

  it("indexes heading text for full-text retrieval", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/a.md#acmeauthclientv2",
        filepath: "docs/a.md",
        heading: "AcmeAuthClientV2",
        heading_level: 2,
        content: "Initialize the client with your API key.",
        content_text: "Initialize the client with your API key.",
        breadcrumb: "docs/a.md > AcmeAuthClientV2",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/b.md#retry",
        filepath: "docs/b.md",
        heading: "Retry",
        heading_level: 2,
        content: "Retry guidance",
        content_text: "Retry guidance",
        breadcrumb: "docs/b.md > Retry",
        chunk_index: 0,
        metadata: {},
      },
    ];

    await buildLanceDbIndex({
      dbPath: dir,
      chunks,
    });

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const result = await engine.search({
      query: "AcmeAuthClientV2",
      limit: 5,
      filters: {},
    });

    expect(result.hits[0]?.chunk_id).toBe("docs/a.md#acmeauthclientv2");
    expect(result.hint).toBeNull();
  });

  it("blends in vector rank when query embeddings are available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/a.md#retry-a",
        filepath: "docs/a.md",
        heading: "Retry A",
        heading_level: 2,
        content: "Retry strategy details",
        content_text: "Retry strategy details",
        breadcrumb: "docs/a.md > Retry A",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/b.md#retry-b",
        filepath: "docs/b.md",
        heading: "Retry B",
        heading_level: 2,
        content: "Retry strategy details",
        content_text: "Retry strategy details",
        breadcrumb: "docs/b.md > Retry B",
        chunk_index: 0,
        metadata: {},
      },
    ];

    const vectorsByChunkId = new Map<string, number[]>([
      ["docs/a.md#retry-a", [1, 0, 0]],
      ["docs/b.md#retry-b", [0, 1, 0]],
    ]);

    await buildLanceDbIndex({
      dbPath: dir,
      chunks,
      vectorsByChunkId,
    });

    const queryEmbeddingProvider: EmbeddingProvider = {
      name: "hash",
      model: "test",
      dimensions: 3,
      async embed(): Promise<number[][]> {
        return [[0, 1, 0]];
      },
    };

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
      proximityWeight: 1,
      vectorWeight: 50,
      queryEmbeddingProvider,
    });

    const result = await engine.search({
      query: "retry strategy",
      limit: 10,
      filters: {},
    });

    expect(result.hits[0]?.chunk_id).toBe("docs/b.md#retry-b");
  });

  it("emits a warning and falls back to lexical search when vector query fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/a.md#retry",
        filepath: "docs/a.md",
        heading: "Retry",
        heading_level: 2,
        content: "Retry strategy details",
        content_text: "Retry strategy details",
        breadcrumb: "docs/a.md > Retry",
        chunk_index: 0,
        metadata: {},
      },
    ];

    const vectorsByChunkId = new Map<string, number[]>([["docs/a.md#retry", [1, 0, 0]]]);
    await buildLanceDbIndex({
      dbPath: dir,
      chunks,
      vectorsByChunkId,
    });

    const warnings: string[] = [];
    const queryEmbeddingProvider: EmbeddingProvider = {
      name: "openai",
      model: "test",
      dimensions: 3,
      async embed(): Promise<number[][]> {
        throw new Error("provider unavailable");
      },
    };

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
      queryEmbeddingProvider,
      onWarning(message) {
        warnings.push(message);
      },
    });

    const result = await engine.search({
      query: "retry",
      limit: 10,
      filters: {},
    });

    expect(result.hits[0]?.chunk_id).toBe("docs/a.md#retry");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/vector search degraded to lexical-only/);
  });

  it("returns get_doc context with delimiter grammar", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/file.md#one",
        filepath: "docs/file.md",
        heading: "One",
        heading_level: 2,
        content: "one",
        content_text: "one",
        breadcrumb: "docs/file.md > One",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/file.md#two",
        filepath: "docs/file.md",
        heading: "Two",
        heading_level: 2,
        content: "two",
        content_text: "two",
        breadcrumb: "docs/file.md > Two",
        chunk_index: 1,
        metadata: {},
      },
      {
        chunk_id: "docs/file.md#three",
        filepath: "docs/file.md",
        heading: "Three",
        heading_level: 2,
        content: "three",
        content_text: "three",
        breadcrumb: "docs/file.md > Three",
        chunk_index: 2,
        metadata: {},
      },
    ];

    await buildLanceDbIndex({ dbPath: dir, chunks });

    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const doc = await engine.getDoc({
      chunk_id: "docs/file.md#two",
      context: 1,
    });

    expect(doc.text).toContain("(Target)");
    expect(doc.text).toContain("Context: -1");
    expect(doc.text).toContain("Context: +1");
  });

  it("returns a hint payload when no hits are found", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/file.md#retry",
        filepath: "docs/file.md",
        heading: "Retry",
        heading_level: 2,
        content: "Retry docs",
        content_text: "Retry docs",
        breadcrumb: "docs/file.md > Retry",
        chunk_index: 0,
        metadata: {},
      },
    ];

    await buildLanceDbIndex({ dbPath: dir, chunks });
    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const result = await engine.search({
      query: "nonexistent-token",
      limit: 5,
      filters: {},
    });

    expect(result.hits).toHaveLength(0);
    expect(result.hint).not.toBeNull();
  });

  it("rejects cursor reuse across a different query context", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const chunks: Chunk[] = [
      {
        chunk_id: "docs/file.md#retry",
        filepath: "docs/file.md",
        heading: "Retry",
        heading_level: 2,
        content: "retry",
        content_text: "retry",
        breadcrumb: "docs/file.md > Retry",
        chunk_index: 0,
        metadata: {},
      },
      {
        chunk_id: "docs/file.md#python",
        filepath: "docs/file.md",
        heading: "Python",
        heading_level: 2,
        content: "python",
        content_text: "python",
        breadcrumb: "docs/file.md > Python",
        chunk_index: 1,
        metadata: {},
      },
    ];

    await buildLanceDbIndex({ dbPath: dir, chunks });
    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const first = await engine.search({
      query: "retry python",
      limit: 1,
      filters: {},
    });
    expect(first.next_cursor).toBeTypeOf("string");

    await expect(
      engine.search({
        query: "python",
        limit: 1,
        cursor: first.next_cursor ?? undefined,
        filters: {},
      }),
    ).rejects.toThrow(/does not match current query or filters/);
  });

  it("returns entire document when context is -1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const doc = `
# Heading 1
# Auth

## Login
first

## Login
second

# Billing

## Retry
third
`.trim();
    const chunks = buildChunks({
      filepath: "docs/example.md",
      markdown: doc,
      strategy: {
        chunk_by: "h2",
      },
    });

    await buildLanceDbIndex({ dbPath: dir, chunks });
    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const result = await engine.getDoc({
      chunk_id: chunks[1].chunk_id,
      context: -1,
    });

    expect(result.text).toContain(doc);
  });

  it("returns entire document without other documents when context is -1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lancedb-"));
    tempDirs.push(dir);

    const doc1 = `
Example document before
`.trim();
    const chunks = buildChunks({
      filepath: "docs/example-1.md",
      markdown: doc1,
      strategy: {
        chunk_by: "h2",
      },
    });

    const doc2 = `
# Heading 1
# Auth

## Login
first

## Login
second

# Billing

## Retry
third
`.trim();
    const target = buildChunks({
      filepath: "docs/example-2.md",
      markdown: doc2,
      strategy: {
        chunk_by: "h2",
      },
    });
    chunks.push(...target);

    const doc3 = `
# Testing with multiple documents

## Section 1

Greetings friend!
`.trim();
    chunks.push(
      ...buildChunks({
        filepath: "docs/example-3.md",
        markdown: doc3,
        strategy: {
          chunk_by: "h2",
        },
      }),
    );

    await buildLanceDbIndex({ dbPath: dir, chunks });
    const engine = await LanceDbSearchEngine.open({
      dbPath: dir,
      metadataKeys: [],
    });

    const result = await engine.getDoc({
      chunk_id: target[1].chunk_id,
      context: -1,
    });

    expect(result.text).toContain(doc2);
  });
});
