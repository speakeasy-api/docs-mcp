import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DocsIndex, normalizeMetadata, type Chunk } from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";

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
  corpus_description: "Test docs",
  taxonomy: {
    language: {
      description: "Filter by language.",
      values: ["python", "typescript"],
    },
    scope: {
      values: ["global-guide", "sdk-specific"],
    },
  },
  stats: {
    total_chunks: 2,
    total_files: 2,
    indexed_at: "2026-01-01T00:00:00Z",
  },
  embedding: null,
});

// Use a random high port to avoid conflicts
const TEST_PORT = 0; // let the OS pick

let httpServer: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
  const handle = await startHttpServer(app, { port: TEST_PORT });
  httpServer = handle.httpServer;
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : handle.port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

describe("MCP HTTP transport compliance", () => {
  it("completes initialize handshake via SDK client", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info?.name).toBe("@speakeasy-api/docs-mcp-server");

    await client.close();
  });

  it("lists tools with correct schema", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_docs");
    expect(names).toContain("get_doc");

    const searchTool = tools.find((t) => t.name === "search_docs");
    const props =
      ((searchTool?.inputSchema as Record<string, unknown> | undefined)?.properties as Record<
        string,
        unknown
      >) ?? {};
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("language");
    expect(props).toHaveProperty("scope");

    await client.close();
  });

  it("calls search_docs tool and returns results", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "search_docs",
      arguments: { query: "retry" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);

    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.hits.length).toBeGreaterThan(0);

    await client.close();
  });

  it("calls get_doc tool and returns content", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "get_doc",
      arguments: { chunk_id: "guides/ts.md#retry" },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("TypeScript retry");

    await client.close();
  });

  it("returns error for unknown tool", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "nonexistent",
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await client.close();
  });

  it("returns 405 for non-/mcp paths", async () => {
    const res = await fetch(`${baseUrl}/other`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns JSON-RPC parse error for empty body", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });

  it("returns JSON-RPC parse error for invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe(-32700);
  });

  it("server stays alive after bad requests", async () => {
    // Send a sequence of bad requests, then verify the server still works
    await fetch(`${baseUrl}/mcp`, { method: "POST", body: "" });
    await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{broken" });
    await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    await fetch(`${baseUrl}/bogus`, { method: "POST" });

    // Server should still serve a valid MCP request
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

describe("MCP HTTP transport with toolPrefix", () => {
  let prefixedHttpServer: http.Server;
  let prefixedBaseUrl: string;

  beforeAll(async () => {
    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
    });
    const handle = await startHttpServer(app, {
      name: "acme-docs-server",
      port: 0,
    });
    prefixedHttpServer = handle.httpServer;
    const addr = prefixedHttpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : handle.port;
    prefixedBaseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (prefixedHttpServer) {
      await new Promise<void>((resolve) => prefixedHttpServer.close(() => resolve()));
    }
  });

  it("reports prefixed server name", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${prefixedBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const info = client.getServerVersion();
    expect(info?.name).toBe("acme-docs-server");

    await client.close();
  });

  it("lists prefixed tool names", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${prefixedBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("acme_search_docs");
    expect(names).toContain("acme_get_doc");
    expect(names).not.toContain("search_docs");
    expect(names).not.toContain("get_doc");

    await client.close();
  });

  it("calls acme_search_docs and returns results", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${prefixedBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "acme_search_docs",
      arguments: { query: "retry" },
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.hits.length).toBeGreaterThan(0);

    await client.close();
  });

  it("calls acme_get_doc and returns content", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${prefixedBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "acme_get_doc",
      arguments: { chunk_id: "guides/ts.md#retry" },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("TypeScript retry");

    await client.close();
  });
});

describe("HTTP session management", () => {
  it("rejects new sessions when maxSessions is reached", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0, maxSessions: 1 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      // First client — should succeed.
      const transport1 = new StreamableHTTPClientTransport(url);
      const client1 = new Client({ name: "client-1", version: "0.1.0" });
      await client1.connect(transport1);

      // Second client — should be rejected with 503.
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "client-2", version: "0.1.0" },
          },
          id: 1,
        }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.message).toMatch(/Too many active sessions/);

      await client1.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("returns 404 for unknown session ID", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": "nonexistent-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1,
        }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toMatch(/Session not found/);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("evicts sessions after idle timeout", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0, sessionTimeoutMs: 100 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      // Create a session via the SDK client.
      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: "timeout-client", version: "0.1.0" });
      await client.connect(transport);

      // Tool call should work immediately.
      const result = await client.callTool({ name: "search_docs", arguments: { query: "retry" } });
      expect(result.isError).not.toBe(true);

      // Wait for idle timeout to expire.
      await new Promise((r) => setTimeout(r, 200));

      // The session should have been evicted — next call should fail.
      await expect(
        client.callTool({ name: "search_docs", arguments: { query: "retry" } }),
      ).rejects.toThrow();

      // A new client should still be able to connect (session slot freed).
      const transport2 = new StreamableHTTPClientTransport(url);
      const client2 = new Client({ name: "new-client", version: "0.1.0" });
      await client2.connect(transport2);
      const result2 = await client2.callTool({ name: "search_docs", arguments: { query: "retry" } });
      expect(result2.isError).not.toBe(true);
      await client2.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("frees session slot after client sends DELETE via terminateSession", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0, maxSessions: 1 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      // Fill the single session slot.
      const transport1 = new StreamableHTTPClientTransport(url);
      const client1 = new Client({ name: "client-1", version: "0.1.0" });
      await client1.connect(transport1);

      // terminateSession() sends DELETE to the server, then close() tears down locally.
      await transport1.terminateSession();
      await client1.close();

      // A new client should now be able to connect.
      const transport2 = new StreamableHTTPClientTransport(url);
      const client2 = new Client({ name: "client-2", version: "0.1.0" });
      await client2.connect(transport2);

      const { tools } = await client2.listTools();
      expect(tools.length).toBeGreaterThan(0);

      await client2.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("DELETE with missing session ID returns 400", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toMatch(/Missing mcp-session-id/);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("DELETE with unknown session ID returns 404", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": "bogus-id" },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toMatch(/Session not found/);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });
});
