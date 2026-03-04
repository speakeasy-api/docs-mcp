import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("MCP HTTP transport resources", () => {
  let resourceHttpServer: http.Server;
  let resourceBaseUrl: string;

  const metadataWithResources = normalizeMetadata({
    metadata_version: "1.1.0",
    corpus_description: "Test docs",
    taxonomy: {
      language: {
        description: "Filter by language.",
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
      indexed_at: "2026-01-01T00:00:00Z",
    },
    embedding: null,
  });

  beforeAll(async () => {
    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata: metadataWithResources,
    });
    const handle = await startHttpServer(app, { port: 0 });
    resourceHttpServer = handle.httpServer;
    const addr = resourceHttpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : handle.port;
    resourceBaseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (resourceHttpServer) {
      await new Promise<void>((resolve) => resourceHttpServer.close(() => resolve()));
    }
  });

  it("lists resources via MCP protocol", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${resourceBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const { resources } = await client.listResources();
    expect(resources).toHaveLength(2);
    const sorted = [...resources].sort((a, b) => a.uri.localeCompare(b.uri));
    expect(sorted[0].uri).toBe("docs:///guides/global.md");
    expect(sorted[1].uri).toBe("docs:///guides/ts.md");
    for (const r of sorted) {
      expect(r.mimeType).toBe("text/markdown");
    }

    await client.close();
  });

  it("reads a resource via MCP protocol", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${resourceBaseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.readResource({
      uri: "docs:///guides/ts.md",
    });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toContain("TypeScript retry");

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
  it("falls back to stateless for unknown session ID", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "nonexistent-session-id",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      expect(lines.length).toBeGreaterThan(0);
      const body = JSON.parse(lines[0].slice(6));
      expect(body.result.tools.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("cleans up session after client sends DELETE via terminateSession", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport1 = new StreamableHTTPClientTransport(url);
      const client1 = new Client({ name: "client-1", version: "0.1.0" });
      await client1.connect(transport1);

      // terminateSession() sends DELETE to the server, then close() tears down locally.
      await transport1.terminateSession();
      await client1.close();

      // A new client should be able to connect.
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

  it("DELETE with missing session ID is idempotent", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, { method: "DELETE" });
      expect(res.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("DELETE with unknown session ID is idempotent", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": "bogus-id" },
      });
      expect(res.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });
});

describe("HTTP built-in request retry consistency", () => {
  function builtInRequests(): Record<string, unknown>[] {
    return [
      {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 101,
      },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "search_docs", arguments: { query: "retry" } },
        id: 102,
      },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_doc", arguments: { chunk_id: "guides/ts.md#retry" } },
        id: 103,
      },
    ];
  }

  async function postMcpRequest(
    url: string,
    request: Record<string, unknown>,
    sessionId?: string,
  ): Promise<{ status: number; rawBody: string; body?: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    const text = await res.text();
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.slice(6).trim().length > 0);

    let parsed: Record<string, unknown> | undefined;
    const payload = dataLine ? dataLine.slice(6) : text;
    if (payload.trim().length > 0) {
      const json = JSON.parse(payload);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = Object.fromEntries(Object.entries(json));
      }
    }

    return {
      status: res.status,
      rawBody: text,
      ...(parsed ? { body: parsed } : {}),
    };
  }

  async function createStaleSessionId(url: URL): Promise<string> {
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "retry-test-client", version: "0.1.0" });
    await client.connect(transport);

    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      throw new Error("Expected sessionId after initialize");
    }

    await transport.terminateSession();
    await client.close();
    return sessionId;
  }

  it("returns same responses for repeated requests with active session", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: "retry-test-client", version: "0.1.0" });
      await client.connect(transport);

      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      if (!sessionId) {
        throw new Error("Expected sessionId after initialize");
      }

      for (const request of builtInRequests()) {
        const first = await postMcpRequest(url.toString(), request, sessionId);
        const second = await postMcpRequest(url.toString(), request, sessionId);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.body).toBeDefined();
        expect(second.body).toBeDefined();
        expect(second.body).toEqual(first.body);
      }

      await client.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("returns same responses for repeated requests without session header", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = `http://localhost:${port}/mcp`;

      for (const request of builtInRequests()) {
        const first = await postMcpRequest(url, request);
        const second = await postMcpRequest(url, request);
        expect(second.status).toBe(first.status);
        expect(second.rawBody).toBe(first.rawBody);
        if (first.body || second.body) {
          expect(second.body).toEqual(first.body);
        }
      }
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("returns same responses for repeated requests with stale session header", async () => {
    const app = new McpDocsServer({ index: new DocsIndex(chunks), metadata });
    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);
      const staleSessionId = await createStaleSessionId(url);

      for (const request of builtInRequests()) {
        const first = await postMcpRequest(url.toString(), request, staleSessionId);
        const second = await postMcpRequest(url.toString(), request, staleSessionId);
        expect(second.status).toBe(first.status);
        expect(second.rawBody).toBe(first.rawBody);
        if (first.body || second.body) {
          expect(second.body).toEqual(first.body);
        }
      }
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });
});
