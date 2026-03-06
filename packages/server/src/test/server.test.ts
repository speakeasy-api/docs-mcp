import { describe, expect, assert, it } from "vitest";
import { DocsIndex, normalizeMetadata, type Chunk } from "@speakeasy-api/docs-mcp-core";
import { createTestServer } from "./mcp.helper.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

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
  it("includes conceptual query guidance when vector search is available", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
        vectorSearchAvailable: true,
      },
    });
    const { client } = pair;

    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search?.description).toContain("conceptual queries");
  });

  it("omits conceptual query guidance when vector search is unavailable", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
        vectorSearchAvailable: false,
      },
    });
    const { client } = pair;

    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search?.description).not.toContain("conceptual queries");
  });

  it("builds dynamic schema with injected taxonomy enums", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "search_docs");
    expect(search).toBeDefined();

    const schema = search?.inputSchema as Record<string, Record<string, unknown>>;
    expect(schema).toHaveProperty("properties.language.enum", ["python", "typescript"]);
    expect(schema).toHaveProperty("properties.scope.enum", ["global-guide", "sdk-specific"]);
    expect(schema).toHaveProperty("properties.scope.description", "Filter results by scope.");
  });

  it("passes through auto-include behavior from core", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const result = await client.callTool({
      name: "search_docs",
      arguments: {
        query: "retry",
        language: "typescript",
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBe(false);
    assert(parsed.content[0]?.type === "text");
    const payload = JSON.parse(parsed.content[0].text);
    const hitIds = payload.hits.map((entry: { chunk_id: string }) => entry.chunk_id).sort();
    expect(hitIds).toEqual(["guides/global.md#retry", "guides/ts.md#retry"]);
  });

  it("returns structured errors for invalid cursor", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const result = await client.callTool({
      name: "search_docs",
      arguments: {
        query: "retry",
        cursor: "bad-cursor",
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBe(true);
    assert(parsed.content[0]?.type === "text");
    expect(parsed.content[0].text).toMatch(/Invalid cursor/);
  });

  it("rejects unknown fields in search_docs", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const result = await client.callTool({
      name: "search_docs",
      arguments: {
        query: "retry",
        unsupported: "x",
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBe(true);
    assert(parsed.content[0]?.type === "text");
    expect(parsed.content[0].text).toMatch(/Unexpected field 'unsupported'/);
  });

  it("enforces numeric bounds for limit and context", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const limitResult = await client.callTool({
      name: "search_docs",
      arguments: {
        query: "retry",
        limit: 0,
      },
    });
    const badLimit = CallToolResultSchema.parse(limitResult);
    expect(badLimit.isError).toBe(true);
    assert(badLimit.content[0]?.type === "text");
    expect(badLimit.content[0].text).toMatch(/limit must be between 1 and 50/);

    const contextResult = await client.callTool({
      name: "get_doc",
      arguments: {
        chunk_id: "guides/ts.md#retry",
        context: 6,
      },
    });
    const badContext = CallToolResultSchema.parse(contextResult);
    expect(badContext.isError).toBe(true);
    assert(badContext.content[0]?.type === "text");
    expect(badContext.content[0].text).toMatch(/context must be between 0 and 5/);
  });
});

describe("McpDocsServer with toolPrefix", () => {
  it("prefixes tool names when toolPrefix is set", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
        toolPrefix: "acme",
      },
    });
    const { client } = pair;

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("acme_search_docs");
    expect(names).toContain("acme_get_doc");
    expect(names).not.toContain("search_docs");
    expect(names).not.toContain("get_doc");
  });

  it("routes prefixed tool names to the correct handlers", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
        toolPrefix: "acme",
      },
    });
    const { client } = pair;

    const result = await client.callTool({
      name: "acme_search_docs",
      arguments: {
        query: "retry",
        language: "typescript",
      },
    });
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBe(false);
    assert(parsed.content[0]?.type === "text");
    const payload = JSON.parse(parsed.content[0].text);
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  it("rejects unprefixed tool names when prefix is set", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
        toolPrefix: "acme",
      },
    });
    const { client } = pair;

    const result = await client.callTool({
      name: "search_docs",
      arguments: { query: "retry" },
    });
    const parsed = CallToolResultSchema.parse(result);
    expect(parsed.isError).toBe(true);
    assert(parsed.content[0]?.type === "text");
    expect(parsed.content[0].text).toMatch(/Unknown tool/);
  });
});

describe("McpDocsServer resources", () => {
  it("lists all documents as resources", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const { resources } = await client.listResources();
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

    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata: metadataWithFiles,
      },
    });
    const { client } = pair;

    const { resources } = await client.listResources();
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
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    const result = await client.readResource({ uri: "docs:///guides/ts.md" });
    assert(result.contents[0] && "text" in result.contents[0]);
    expect(result.contents[0].text).toContain("TypeScript retry");
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("throws for nonexistent resource", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    await expect(client.readResource({ uri: "docs:///nonexistent.md" })).rejects.toThrow(
      /Resource not found/,
    );
  });

  it("throws for malformed URI", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata,
      },
    });
    const { client } = pair;

    await expect(client.readResource({ uri: "invalid://uri" })).rejects.toThrow(
      /Invalid URI scheme/,
    );
  });
});

describe("McpDocsServer prompts", () => {
  const metadataWithPrompts = normalizeMetadata({
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
    prompts: [
      {
        name: "guides/auth-integration",
        title: "Auth Integration",
        description: "AcmeAuth integration guidance.",
        arguments: [{ name: "auth_method", description: "Authentication method", required: true }],
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Use {{auth_method}} for this integration." },
          },
          {
            role: "assistant",
            content: { type: "text", text: "I will provide a plan." },
          },
        ],
      },
    ],
  });

  it("lists prompts from metadata", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata: metadataWithPrompts,
      },
    });
    const { client } = pair;

    const { prompts } = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.name).toBe("guides/auth-integration");
    expect(prompts[0]?.arguments?.[0]?.name).toBe("auth_method");
  });

  it("renders prompt with mustache arguments", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata: metadataWithPrompts,
      },
    });
    const { client } = pair;

    const prompt = await client.getPrompt({
      name: "guides/auth-integration",
      arguments: {
        auth_method: "oauth2",
      },
    });

    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]?.content.type).toBe("text");
    if (prompt.messages[0]?.content.type === "text") {
      expect(prompt.messages[0].content.text).toContain("oauth2");
    }
  });

  it("throws when required arguments are missing", async () => {
    await using pair = await createTestServer({
      app: {
        index: new DocsIndex(chunks),
        metadata: metadataWithPrompts,
      },
    });
    const { client } = pair;

    await expect(client.getPrompt({ name: "guides/auth-integration" })).rejects.toThrow(
      /Missing required prompt argument 'auth_method'/,
    );
  });
});
