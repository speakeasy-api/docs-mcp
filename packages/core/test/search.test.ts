import { describe, expect, it } from "vitest";
import { DocsIndex } from "../src/search.js";
import type { Chunk } from "../src/types.js";

const baseChunks: Chunk[] = [
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
    chunk_id: "docs/py.md#retry",
    filepath: "docs/py.md",
    heading: "Retry",
    heading_level: 2,
    content: "Python retry docs",
    content_text: "Python retry docs",
    breadcrumb: "docs/py.md > Retry",
    chunk_index: 0,
    metadata: { language: "python", scope: "sdk-specific" },
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

describe("DocsIndex.search", () => {
  it("auto-includes global guides when language is set without scope", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 10,
      filters: { language: "typescript" },
    });

    expect(result.hits.map((hit) => hit.chunk_id).sort()).toEqual([
      "docs/global.md#retry-guide",
      "docs/legacy.md#retry",
      "docs/ts.md#retry",
    ]);
  });

  it("excludes legacy chunks with a mismatched language when scope is missing", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 10,
      filters: { language: "typescript" },
    });

    expect(result.hits.map((hit) => hit.chunk_id)).not.toContain("docs/legacy-py.md#retry");
  });

  it("respects explicit scope filters", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 10,
      filters: { language: "typescript", scope: "sdk-specific" },
    });

    expect(result.hits.map((hit) => hit.chunk_id)).toEqual(["docs/ts.md#retry"]);
  });

  it("supports stateless cursor pagination", async () => {
    const index = new DocsIndex(baseChunks);

    const first = await index.search({
      query: "retry",
      limit: 1,
      filters: {},
    });

    expect(first.hits).toHaveLength(1);
    expect(first.next_cursor).toBeTypeOf("string");

    const second = await index.search({
      query: "retry",
      limit: 1,
      ...(first.next_cursor ? { cursor: first.next_cursor } : {}),
      filters: {},
    });

    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]?.chunk_id).not.toBe(first.hits[0]?.chunk_id);
  });

  it("rejects cursor reuse across a different query context", async () => {
    const index = new DocsIndex(baseChunks);

    const first = await index.search({
      query: "retry",
      limit: 1,
      filters: {},
    });
    expect(first.next_cursor).toBeTypeOf("string");

    await expect(
      index.search({
        query: "python",
        limit: 1,
        cursor: first.next_cursor ?? undefined,
        filters: {},
      }),
    ).rejects.toThrow(/does not match current query or filters/);
  });

  it("keeps legacy chunks without scope when language auto-include is active", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 10,
      filters: { language: "typescript" },
    });

    expect(result.hits.map((hit) => hit.chunk_id)).toContain("docs/legacy.md#retry");
  });

  it("clamps zero limit to 1", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 0,
      filters: {},
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hint).toBeNull();
  });

  it("always includes a null hint on successful hits", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "retry",
      limit: 5,
      filters: {},
    });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hint).toBeNull();
  });

  it("returns a structured hint when no hits are found", async () => {
    const index = new DocsIndex(baseChunks);

    const result = await index.search({
      query: "no-match-token",
      limit: 5,
      filters: { language: "typescript" },
    });

    expect(result.hits).toHaveLength(0);
    expect(result.hint).not.toBeNull();
  });
});

describe("DocsIndex.getDoc", () => {
  it("returns target chunk with context delimiters", async () => {
    const fileChunks: Chunk[] = [
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

    const index = new DocsIndex(fileChunks);
    const doc = await index.getDoc({
      chunk_id: "docs/file.md#two",
      context: 1,
    });

    expect(doc.text).toContain("(Target)");
    expect(doc.text).toContain("Context: -1");
    expect(doc.text).toContain("Context: +1");
  });
});
