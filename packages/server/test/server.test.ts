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

describe("McpDocsServer instructions", () => {
  it("returns custom instructions when set in metadata", () => {
    const metadataWithInstructions = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Speakeasy SDK docs",
      taxonomy: {},
      stats: { total_chunks: 1, total_files: 1, indexed_at: "2026-01-01T00:00:00Z" },
      embedding: null,
      mcpServerInstructions: "Custom instructions here",
    });

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithInstructions,
    });

    expect(server.getInstructions()).toBe("Custom instructions here");
  });

  it("generates default instructions from metadata when not set", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });

    const instructions = server.getInstructions();
    expect(instructions).toContain("Speakeasy SDK docs");
    expect(instructions).toContain("search_docs");
    expect(instructions).toContain("get_doc");
    expect(instructions).toContain("BEFORE writing code");
    expect(instructions).toContain("language");
    expect(instructions).toContain("typescript");
  });

  it("uses prefixed tool names in default instructions", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
    });

    const instructions = server.getInstructions();
    expect(instructions).toContain("acme_search_docs");
    expect(instructions).toContain("acme_get_doc");
    expect(instructions).not.toContain("`search_docs`");
    expect(instructions).not.toContain("`get_doc`");
  });

  it("omits taxonomy hints when taxonomy is empty", () => {
    const noTaxonomy = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Simple docs",
      taxonomy: {},
      stats: { total_chunks: 1, total_files: 1, indexed_at: "2026-01-01T00:00:00Z" },
      embedding: null,
    });

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: noTaxonomy,
    });

    const instructions = server.getInstructions();
    expect(instructions).toContain("Simple docs");
    expect(instructions).not.toContain("Filter by:");
  });

  it("truncates long taxonomy value lists", () => {
    const manyValues = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Big SDK docs",
      taxonomy: {
        language: {
          values: ["go", "java", "python", "ruby", "rust", "typescript"],
        },
      },
      stats: { total_chunks: 1, total_files: 1, indexed_at: "2026-01-01T00:00:00Z" },
      embedding: null,
    });

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: manyValues,
    });

    const instructions = server.getInstructions();
    expect(instructions).toContain("...");
    expect(instructions).not.toContain("typescript");
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

describe("McpDocsServer resources", () => {
  it("returns empty resources when no taxonomy values have mcp_resource", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
    });
    const resources = await server.getResources();
    expect(resources).toEqual([]);
  });

  it("lists resources for taxonomy values with mcp_resource: true", async () => {
    const metadataWithResources = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Speakeasy SDK docs",
      taxonomy: {
        language: {
          description: "Filter results by programming language.",
          values: ["python", "typescript"],
          properties: {
            typescript: { mcp_resource: true },
          },
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

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithResources,
    });

    const resources = await server.getResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("docs:///guides/ts.md");
    expect(resources[0].name).toBe("guides/ts.md");
    expect(resources[0].mimeType).toBe("text/markdown");
  });

  it("reads a resource and returns file content", async () => {
    const metadataWithResources = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Speakeasy SDK docs",
      taxonomy: {
        language: {
          description: "Filter results by programming language.",
          values: ["python", "typescript"],
          properties: {
            typescript: { mcp_resource: true },
          },
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

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithResources,
    });

    const result = await server.readResource("docs:///guides/ts.md");
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toContain("TypeScript retry");
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("throws for nonexistent resource", async () => {
    const metadataWithResources = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Speakeasy SDK docs",
      taxonomy: {
        language: {
          description: "Filter results by programming language.",
          values: ["python", "typescript"],
          properties: {
            typescript: { mcp_resource: true },
          },
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

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithResources,
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
