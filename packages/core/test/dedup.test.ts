import { describe, expect, it } from "vitest";
import { dedupKey } from "../src/search-common.js";
import { InMemorySearchEngine } from "../src/search.js";
import type { Chunk } from "../src/types.js";

describe("dedupKey", () => {
  const getter = (metadata: Record<string, string>) => (key: string) => metadata[key] ?? "";

  it("returns normalized key for sdk-specific chunk with language in filepath", () => {
    const key = dedupKey(
      "sdks/python/auth.md",
      "Retry Configuration",
      "sdks/python/auth.md#retry-configuration",
      getter({ language: "python", scope: "sdk-specific" }),
      ["language"],
    );
    expect(key).toBe("sdks/*/auth.md:Retry Configuration");
  });

  it("produces matching keys across languages", () => {
    const pyKey = dedupKey(
      "sdks/python/auth.md",
      "Retry Configuration",
      "sdks/python/auth.md#retry-configuration",
      getter({ language: "python", scope: "sdk-specific" }),
      ["language"],
    );
    const goKey = dedupKey(
      "sdks/go/auth.md",
      "Retry Configuration",
      "sdks/go/auth.md#retry-configuration",
      getter({ language: "go", scope: "sdk-specific" }),
      ["language"],
    );
    const tsKey = dedupKey(
      "sdks/typescript/auth.md",
      "Retry Configuration",
      "sdks/typescript/auth.md#retry-configuration",
      getter({ language: "typescript", scope: "sdk-specific" }),
      ["language"],
    );
    expect(pyKey).toBe(goKey);
    expect(goKey).toBe(tsKey);
  });

  it("returns null when collapseKeys is empty", () => {
    const key = dedupKey(
      "sdks/python/auth.md",
      "Retry",
      "sdks/python/auth.md#retry",
      getter({ language: "python" }),
      [],
    );
    expect(key).toBeNull();
  });

  it("returns null when metadata value for collapse key is empty", () => {
    const key = dedupKey(
      "guides/auth.md",
      "Overview",
      "guides/auth.md#overview",
      getter({ scope: "global-guide" }),
      ["language"],
    );
    expect(key).toBeNull();
  });

  it("returns null when language is not a filepath segment", () => {
    const key = dedupKey(
      "guides/auth.md",
      "Overview",
      "guides/auth.md#overview",
      getter({ language: "python" }),
      ["language"],
    );
    expect(key).toBeNull();
  });

  it("differentiates different files with same heading", () => {
    const authKey = dedupKey(
      "sdks/python/auth.md",
      "Overview",
      "sdks/python/auth.md#overview",
      getter({ language: "python" }),
      ["language"],
    );
    const modelsKey = dedupKey(
      "sdks/python/models.md",
      "Overview",
      "sdks/python/models.md#overview",
      getter({ language: "python" }),
      ["language"],
    );
    expect(authKey).not.toBe(modelsKey);
  });

  it("differentiates different headings in same file", () => {
    const initKey = dedupKey(
      "sdks/typescript/auth.md",
      "AcmeAuthClientV2 Initialization",
      "sdks/typescript/auth.md#acmeauthclientv2-initialization",
      getter({ language: "typescript" }),
      ["language"],
    );
    const clientKey = dedupKey(
      "sdks/python/auth.md",
      "Client Initialization",
      "sdks/python/auth.md#client-initialization",
      getter({ language: "python" }),
      ["language"],
    );
    expect(initKey).not.toBe(clientKey);
  });

  it("includes part number for multi-part chunks", () => {
    const key = dedupKey(
      "sdks/python/auth.md",
      "Configuration",
      "sdks/python/auth.md#configuration-part-2",
      getter({ language: "python" }),
      ["language"],
    );
    expect(key).toBe("sdks/*/auth.md:Configuration:2");
  });

  it("deduplicates each part independently", () => {
    const part1 = dedupKey(
      "sdks/python/auth.md",
      "Configuration",
      "sdks/python/auth.md#configuration-part-1",
      getter({ language: "python" }),
      ["language"],
    );
    const part2 = dedupKey(
      "sdks/python/auth.md",
      "Configuration",
      "sdks/python/auth.md#configuration-part-2",
      getter({ language: "python" }),
      ["language"],
    );
    expect(part1).not.toBe(part2);
  });

  it("only replaces first occurrence of language segment", () => {
    const key = dedupKey(
      "go/tutorials/go/basics.md",
      "Intro",
      "go/tutorials/go/basics.md#intro",
      getter({ language: "go" }),
      ["language"],
    );
    expect(key).toBe("*/tutorials/go/basics.md:Intro");
  });

  it("handles preamble chunks with empty heading", () => {
    const pyKey = dedupKey(
      "sdks/python/auth.md",
      "",
      "sdks/python/auth.md",
      getter({ language: "python" }),
      ["language"],
    );
    const goKey = dedupKey("sdks/go/auth.md", "", "sdks/go/auth.md", getter({ language: "go" }), [
      "language",
    ]);
    expect(pyKey).toBe(goKey);
    expect(pyKey).toBe("sdks/*/auth.md:");
  });
});

describe("InMemorySearchEngine dedup", () => {
  function makeChunk(overrides: Partial<Chunk> & { chunk_id: string; filepath: string }): Chunk {
    return {
      heading: "",
      heading_level: 2,
      content: "content",
      content_text: "retry configuration docs",
      breadcrumb: "",
      chunk_index: 0,
      metadata: {},
      ...overrides,
    };
  }

  it("collapses equivalent SDK chunks across languages", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "sdk/python/readme.md#installation",
        filepath: "sdk/python/readme.md",
        heading: "Installation",
        content_text: "install pip acmeauth",
        metadata: { language: "python", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "sdk/typescript/readme.md#installation",
        filepath: "sdk/typescript/readme.md",
        heading: "Installation",
        content_text: "install npm acmeauth sdk",
        metadata: { language: "typescript", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "guides/auth.md#overview",
        filepath: "guides/auth.md",
        heading: "Overview",
        content_text: "authentication overview installation guide",
        metadata: { scope: "global-guide" },
      }),
    ];

    const engine = new InMemorySearchEngine(chunks, {
      collapseKeys: ["language"],
    });
    const result = await engine.search({
      query: "install",
      limit: 10,
      filters: {},
    });

    // Should get 2 results: one SDK (collapsed) + one guide
    expect(result.hits).toHaveLength(2);

    const sdkHits = result.hits.filter((h) => h.metadata.scope === "sdk-specific");
    const guideHits = result.hits.filter((h) => h.metadata.scope === "global-guide");
    expect(sdkHits).toHaveLength(1);
    expect(guideHits).toHaveLength(1);
  });

  it("keeps the highest-scoring result when collapsing", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "sdk/python/readme.md#installation",
        filepath: "sdk/python/readme.md",
        heading: "Installation",
        content_text: "install install install pip acmeauth", // higher score (more matches)
        metadata: { language: "python", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "sdk/typescript/readme.md#installation",
        filepath: "sdk/typescript/readme.md",
        heading: "Installation",
        content_text: "install npm",
        metadata: { language: "typescript", scope: "sdk-specific" },
      }),
    ];

    const engine = new InMemorySearchEngine(chunks, {
      collapseKeys: ["language"],
    });
    const result = await engine.search({
      query: "install",
      limit: 10,
      filters: {},
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.chunk_id).toBe("sdk/python/readme.md#installation");
  });

  it("skips dedup when language filter is active", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "sdk/python/readme.md#installation",
        filepath: "sdk/python/readme.md",
        heading: "Installation",
        content_text: "install pip acmeauth",
        metadata: { language: "python", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "sdk/python/readme.md#quickstart",
        filepath: "sdk/python/readme.md",
        heading: "Quick Start",
        content_text: "install quick start guide",
        metadata: { language: "python", scope: "sdk-specific" },
      }),
    ];

    const engine = new InMemorySearchEngine(chunks, {
      collapseKeys: ["language"],
    });
    const result = await engine.search({
      query: "install",
      limit: 10,
      filters: { language: "python" },
    });

    // Both python chunks should survive since language filter makes dedup a no-op
    expect(result.hits).toHaveLength(2);
  });

  it("does not collapse when collapseKeys is empty", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "sdk/python/readme.md#installation",
        filepath: "sdk/python/readme.md",
        heading: "Installation",
        content_text: "install pip acmeauth",
        metadata: { language: "python", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "sdk/typescript/readme.md#installation",
        filepath: "sdk/typescript/readme.md",
        heading: "Installation",
        content_text: "install npm acmeauth",
        metadata: { language: "typescript", scope: "sdk-specific" },
      }),
    ];

    const engine = new InMemorySearchEngine(chunks);
    const result = await engine.search({
      query: "install",
      limit: 10,
      filters: {},
    });

    expect(result.hits).toHaveLength(2);
  });

  it("preserves guide results while collapsing SDK results", async () => {
    const chunks: Chunk[] = [
      makeChunk({
        chunk_id: "sdk/python/readme.md#error-handling",
        filepath: "sdk/python/readme.md",
        heading: "Error Handling",
        content_text: "error handling retry rate limit",
        metadata: { language: "python", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "sdk/typescript/readme.md#error-handling",
        filepath: "sdk/typescript/readme.md",
        heading: "Error Handling",
        content_text: "error handling retry rate limit",
        metadata: { language: "typescript", scope: "sdk-specific" },
      }),
      makeChunk({
        chunk_id: "guides/rate-limiting.md#overview",
        filepath: "guides/rate-limiting.md",
        heading: "Overview",
        content_text: "rate limit error handling guide",
        metadata: { scope: "global-guide" },
      }),
      makeChunk({
        chunk_id: "guides/webhooks.md#errors",
        filepath: "guides/webhooks.md",
        heading: "Errors",
        content_text: "error handling for webhook deliveries",
        metadata: { scope: "global-guide" },
      }),
    ];

    const engine = new InMemorySearchEngine(chunks, {
      collapseKeys: ["language"],
    });
    const result = await engine.search({
      query: "error handling",
      limit: 10,
      filters: {},
    });

    // 1 SDK result (collapsed from 2) + 2 guide results
    const sdkHits = result.hits.filter((h) => h.metadata.scope === "sdk-specific");
    const guideHits = result.hits.filter((h) => h.metadata.scope === "global-guide");
    expect(sdkHits).toHaveLength(1);
    expect(guideHits).toHaveLength(2);
  });
});
