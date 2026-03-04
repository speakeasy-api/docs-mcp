import { describe, expect, assert, it } from "vitest";
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
  it("includes conceptual query guidance when vector search is available", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      vectorSearchAvailable: true,
    });

    const tools = server.getTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search?.description).toContain("conceptual queries");
  });

  it("omits conceptual query guidance when vector search is unavailable", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      vectorSearchAvailable: false,
    });

    const tools = server.getTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search?.description).not.toContain("conceptual queries");
  });

  it("builds dynamic schema with injected taxonomy enums", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const tools = server.getTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search).toBeDefined();

    const schema = search?.inputSchema as Record<string, Record<string, unknown>>;
    expect(schema).toHaveProperty("properties.language.enum", ["python", "typescript"]);
    expect(schema).toHaveProperty("properties.scope.enum", ["global-guide", "sdk-specific"]);
    expect(schema).toHaveProperty("properties.scope.description", "Filter results by scope.");
  });

  it("passes through auto-include behavior from core", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool(
      "search_docs",
      {
        query: "retry",
        language: "typescript",
      },
      stubContext,
    );

    expect(result.isError).toBe(false);
    assert(result.content[0].type === "text");
    const payload = JSON.parse(result.content[0].text);
    const hitIds = payload.hits.map((entry: { chunk_id: string }) => entry.chunk_id).sort();
    expect(hitIds).toEqual(["guides/global.md#retry", "guides/ts.md#retry"]);
  });

  it("returns structured errors for invalid cursor", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool(
      "search_docs",
      {
        query: "retry",
        cursor: "bad-cursor",
      },
      stubContext,
    );

    expect(result.isError).toBe(true);
    assert(result.content[0].type === "text");
    expect(result.content[0].text).toMatch(/Invalid cursor/);
  });

  it("rejects unknown fields in search_docs", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.callTool(
      "search_docs",
      {
        query: "retry",
        unsupported: "x",
      },
      stubContext,
    );

    expect(result.isError).toBe(true);
    assert(result.content[0].type === "text");
    expect(result.content[0].text).toMatch(/Unexpected field 'unsupported'/);
  });

  it("enforces numeric bounds for limit and context", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const badLimit = await server.callTool(
      "search_docs",
      {
        query: "retry",
        limit: 0,
      },
      stubContext,
    );
    expect(badLimit.isError).toBe(true);
    assert(badLimit.content[0].type === "text");
    expect(badLimit.content[0].text).toMatch(/limit must be between 1 and 50/);

    const badContext = await server.callTool(
      "get_doc",
      {
        chunk_id: "guides/ts.md#retry",
        context: 6,
      },
      stubContext,
    );
    expect(badContext.isError).toBe(true);
    assert(badContext.content[0].type === "text");
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

    const result = await server.callTool(
      "acme_search_docs",
      {
        query: "retry",
        language: "typescript",
      },
      stubContext,
    );

    expect(result.isError).toBe(false);
    assert(result.content[0].type === "text");
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
    assert(result.content[0].type === "text");
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });
});

describe("McpDocsServer resources", () => {
  it("lists all documents as resources", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });
    const resources = await server.getResources();
    expect(resources).toHaveLength(2);
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["docs:///guides/global.md", "docs:///guides/ts.md"]);
    // Without files metadata, name falls back to filepath
    for (const r of resources) {
      expect(r.name).toBe(r.description);
      expect(r.mimeType).toBe("text/markdown");
    }
  });

  it("uses title from files metadata as resource name", async () => {
    const metadataWithFiles = normalizeMetadata({
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
      files: {
        "guides/ts.md": { title: "TypeScript Guide" },
      },
    });

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithFiles,
    });

    const resources = await server.getResources();
    expect(resources).toHaveLength(2);

    const tsResource = resources.find((r) => r.uri === "docs:///guides/ts.md");
    expect(tsResource?.name).toBe("guides/ts.md");
    expect(tsResource?.title).toBe("Guides / TypeScript Guide");
    expect(tsResource?.description).toBe("guides/ts.md");

    const globalResource = resources.find((r) => r.uri === "docs:///guides/global.md");
    expect(globalResource?.name).toBe("guides/global.md");
    expect(globalResource?.title).toBe("Guides / Global");
    expect(globalResource?.description).toBe("guides/global.md");
  });

  it("reads a resource and returns file content", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const result = await server.readResource("docs:///guides/ts.md");
    expect(result.contents).toHaveLength(1);
    assert("text" in result.contents[0]);
    expect(result.contents[0].text).toContain("TypeScript retry");
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("throws for nonexistent resource", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    await expect(server.readResource("docs:///nonexistent.md")).rejects.toThrow(
      /Resource not found/,
    );
  });

  it("throws for malformed URI", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    await expect(server.readResource("invalid://uri")).rejects.toThrow(/Invalid URI scheme/);
  });
});
