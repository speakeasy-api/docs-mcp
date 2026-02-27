import { describe, expect, it } from "vitest";
import { DocsIndex, normalizeMetadata, type Chunk } from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "../src/server.js";
import type { ToolCallContext } from "../src/types.js";

const stubContext: ToolCallContext = { signal: AbortSignal.timeout(5_000) };

const chunks: Chunk[] = [
  {
    chunk_id: "guides/ts.md#retry",
    filepath: "guides/ts.md",
    heading: "Retry",
    heading_level: 2,
    content: "TypeScript retry",
    content_text: "TypeScript retry",
    breadcrumb: "guides/ts.md > Retry",
    chunk_index: 0,
    metadata: { language: "typescript", scope: "sdk-specific" },
  },
  {
    chunk_id: "guides/global.md#retry",
    filepath: "guides/global.md",
    heading: "Retry",
    heading_level: 2,
    content: "Global retry",
    content_text: "Global retry",
    breadcrumb: "guides/global.md > Retry",
    chunk_index: 0,
    metadata: { scope: "global-guide" },
  },
];

const metadata = normalizeMetadata({
  metadata_version: "1.1.0",
  corpus_description: "Speakeasy SDK docs",
  taxonomy: {
    language: {
      description: "Filter results by programming language.",
      values: ["python", "typescript"],
    },
    scope: {
      values: ["global-guide", "sdk-specific"],
    },
  },
  stats: {
    total_chunks: 2,
    total_files: 2,
    indexed_at: "2026-02-22T00:00:00Z",
  },
  embedding: null,
});

describe("McpDocsServer", () => {
  it("builds dynamic schema with injected taxonomy enums", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const tools = server.getTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search).toBeDefined();

    const schema = search?.inputSchema as Record<string, Record<string, unknown>>;
    expect(schema.properties.language.enum).toEqual(["python", "typescript"]);
    expect(schema.properties.scope.enum).toEqual(["global-guide", "sdk-specific"]);
    expect(schema.properties.scope.description).toBe("Filter results by scope.");
  });

  it("passes through auto-include behavior from core", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool("search_docs", {
      query: "retry",
      language: "typescript",
    }, stubContext);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    const hitIds = payload.hits.map((entry: { chunk_id: string }) => entry.chunk_id).sort();
    expect(hitIds).toEqual(["guides/global.md#retry", "guides/ts.md#retry"]);
  });

  it("returns structured errors for invalid cursor", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool("search_docs", {
      query: "retry",
      cursor: "bad-cursor",
    }, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid cursor/);
  });

  it("rejects unknown fields in search_docs", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool("search_docs", {
      query: "retry",
      unsupported: "x",
    }, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unexpected field 'unsupported'/);
  });

  it("enforces numeric bounds for limit and context", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const badLimit = await server.callTool("search_docs", {
      query: "retry",
      limit: 0,
    }, stubContext);
    expect(badLimit.isError).toBe(true);
    expect(badLimit.content[0].text).toMatch(/limit must be between 1 and 50/);

    const badContext = await server.callTool("get_doc", {
      chunk_id: "guides/ts.md#retry",
      context: 6,
    }, stubContext);
    expect(badContext.isError).toBe(true);
    expect(badContext.content[0].text).toMatch(/context must be between 0 and 5/);
  });
});

describe("McpDocsServer with toolPrefix", () => {
  it("prefixes tool names when toolPrefix is set", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
    });

    const tools = server.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("acme_search_docs");
    expect(names).toContain("acme_get_doc");
    expect(names).not.toContain("search_docs");
    expect(names).not.toContain("get_doc");
  });

  it("routes prefixed tool names to the correct handlers", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
    });

    const result = await server.callTool("acme_search_docs", {
      query: "retry",
      language: "typescript",
    }, stubContext);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  it("rejects unprefixed tool names when prefix is set", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
    });

    const result = await server.callTool("search_docs", { query: "retry" }, stubContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });
});
