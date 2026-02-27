import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DocsIndex, normalizeMetadata, type Chunk } from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "../src/server.js";
import { startHttpServer } from "../src/http.js";
import type { CustomTool, ToolCallContext } from "../src/types.js";

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
    metadata: { language: "typescript" }
  }
];

const metadata = normalizeMetadata({
  metadata_version: "1.1.0",
  corpus_description: "Test docs",
  taxonomy: {
    language: {
      description: "Filter by language.",
      values: ["python", "typescript"]
    }
  },
  stats: { total_chunks: 1, total_files: 1, indexed_at: "2026-01-01T00:00:00Z" },
  embedding: null
});

const feedbackTool: CustomTool = {
  name: "submit_feedback",
  description: "Submit feedback about a doc page",
  inputSchema: {
    type: "object",
    properties: {
      chunk_id: { type: "string" },
      rating: { type: "integer", minimum: 1, maximum: 5 }
    },
    required: ["chunk_id", "rating"]
  },
  handler: async (args) => {
    const input = args as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: `Feedback received: ${input.rating}` }],
      isError: false
    };
  }
};

const throwingTool: CustomTool = {
  name: "always_throws",
  description: "A tool that always throws",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    throw new Error("Something went wrong");
  }
};

describe("McpDocsServer custom tools", () => {
  it("getTools includes custom tools after built-ins in declaration order", () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool, throwingTool]
    });

    const tools = server.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["search_docs", "get_doc", "submit_feedback", "always_throws"]);
  });

  it("callTool routes to custom handler and returns result", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool]
    });

    const result = await server.callTool("submit_feedback", {
      chunk_id: "guides/ts.md#retry",
      rating: 5
    }, stubContext);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("Feedback received: 5");
  });

  it("custom handler that throws returns isError response", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [throwingTool]
    });

    const result = await server.callTool("always_throws", {}, stubContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Something went wrong");
  });

  it("still routes built-in tools correctly with custom tools present", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool]
    });

    const result = await server.callTool("search_docs", { query: "retry" }, stubContext);
    expect(result.isError).toBe(false);
  });

  it("returns unknown tool error for names that don't match anything", async () => {
    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool]
    });

    const result = await server.callTool("nonexistent", {}, stubContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });
});

describe("McpDocsServer context threading", () => {
  it("passes context through to custom handler", async () => {
    const spy = vi.fn<(args: unknown, context: ToolCallContext) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>>();
    spy.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false
    });

    const contextTool: CustomTool = {
      name: "ctx_echo",
      description: "Echoes context",
      inputSchema: { type: "object", properties: {} },
      handler: spy
    };

    const server = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [contextTool]
    });

    const context: ToolCallContext = {
      signal: AbortSignal.timeout(5_000),
      authInfo: { token: "tok", clientId: "c1", scopes: ["read"] },
      headers: { authorization: "Bearer tok" },
      clientInfo: { name: "test", version: "1.0" }
    };

    await server.callTool("ctx_echo", { foo: "bar" }, context);

    expect(spy).toHaveBeenCalledOnce();
    const [receivedArgs, receivedCtx] = spy.mock.calls[0];
    expect(receivedArgs).toEqual({ foo: "bar" });
    expect(receivedCtx).toBe(context);
  });

});

describe("McpDocsServer custom tool name validation", () => {
  it("rejects duplicate custom tool names", () => {
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool, { ...feedbackTool }]
    })).toThrow(/Duplicate custom tool name 'submit_feedback'/);
  });

  it("rejects custom tool name colliding with built-in (no prefix)", () => {
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{ ...feedbackTool, name: "search_docs" }]
    })).toThrow(/collides with a built-in tool name/);
  });

  it("rejects custom tool name colliding with prefixed built-in", () => {
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "acme",
      customTools: [{ ...feedbackTool, name: "acme_search_docs" }]
    })).toThrow(/collides with a built-in tool name/);
  });

  it("rejects tool name with invalid characters", () => {
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{ ...feedbackTool, name: "bad tool!" }]
    })).toThrow(/must match MCP spec/);
  });

  it("rejects tool name exceeding 64 chars", () => {
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{ ...feedbackTool, name: "a".repeat(65) }]
    })).toThrow(/must match MCP spec/);
  });

  it("rejects toolPrefix that makes built-in names exceed 64 chars", () => {
    // "a".repeat(53) + "_search_docs" = 53 + 1 + 11 = 65 chars
    expect(() => new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      toolPrefix: "a".repeat(53)
    })).toThrow(/exceeds 64 characters/);
  });
});

describe("Custom tools over HTTP transport", () => {
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [feedbackTool, throwingTool]
    });
    const handle = await startHttpServer(app, { port: 0 });
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

  it("listTools includes custom tools after built-ins", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["search_docs", "get_doc", "submit_feedback", "always_throws"]);

    await client.close();
  });

  it("callTool routes to custom handler correctly", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "submit_feedback",
      arguments: { chunk_id: "guides/ts.md#retry", rating: 4 }
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("Feedback received: 4");

    await client.close();
  });

  it("custom handler that throws returns isError response (not transport 500)", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "always_throws",
      arguments: {}
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("Something went wrong");

    await client.close();
  });
});

describe("HTTP authentication", () => {
  it("authenticate hook returns AuthInfo → custom handler sees context.authInfo", async () => {
    const handlerSpy = vi.fn<(args: unknown, context: ToolCallContext) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>>();
    handlerSpy.mockImplementation(async (_args, ctx) => ({
      content: [{ type: "text", text: `client=${ctx.authInfo?.clientId ?? "none"}` }],
      isError: false
    }));

    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{
        name: "auth_echo",
        description: "Echoes auth info",
        inputSchema: { type: "object", properties: {} },
        handler: handlerSpy
      }]
    });

    const handle = await startHttpServer(app, {
      port: 0,
      authenticate: async ({ headers }) => {
        const auth = headers.authorization;
        const token = typeof auth === "string" ? auth.replace("Bearer ", "") : "";
        if (!token) throw new Error("Missing token");
        return { token, clientId: "test-client-id", scopes: ["read"] };
      }
    });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { Authorization: "Bearer my-secret-token" }
        }
      });
      const client = new Client({ name: "test-client", version: "0.1.0" });
      await client.connect(transport);

      const result = await client.callTool({
        name: "auth_echo",
        arguments: {}
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toBe("client=test-client-id");

      await client.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("authenticate hook throws → client receives 401", async () => {
    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata
    });

    const handle = await startHttpServer(app, {
      port: 0,
      authenticate: async () => {
        throw new Error("Invalid credentials");
      }
    });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;

      // Raw HTTP request to verify 401 status code
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
          id: 1
        })
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toBe("Invalid credentials");
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("custom HTTP headers are visible in context.headers", async () => {
    const handlerSpy = vi.fn<(args: unknown, context: ToolCallContext) => Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>>();
    handlerSpy.mockImplementation(async (_args, ctx) => ({
      content: [{ type: "text", text: `x-custom=${ctx.headers?.["x-custom-header"] ?? "missing"}` }],
      isError: false
    }));

    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{
        name: "header_echo",
        description: "Echoes headers",
        inputSchema: { type: "object", properties: {} },
        handler: handlerSpy
      }]
    });

    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { "X-Custom-Header": "hello-world" }
        }
      });
      const client = new Client({ name: "test-client", version: "0.1.0" });
      await client.connect(transport);

      const result = await client.callTool({
        name: "header_echo",
        arguments: {}
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toBe("x-custom=hello-world");

      await client.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("context.signal is always present in HTTP handlers", async () => {
    let receivedSignal: AbortSignal | undefined;

    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{
        name: "signal_check",
        description: "Checks signal presence",
        inputSchema: { type: "object", properties: {} },
        handler: async (_args, ctx) => {
          receivedSignal = ctx.signal;
          return { content: [{ type: "text" as const, text: "ok" }], isError: false };
        }
      }]
    });

    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: "test-client", version: "0.1.0" });
      await client.connect(transport);

      await client.callTool({ name: "signal_check", arguments: {} });
      expect(receivedSignal).toBeInstanceOf(AbortSignal);

      await client.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });

  it("context.clientInfo is populated after session handshake in HTTP", async () => {
    let receivedClientInfo: { name: string; version: string } | undefined;

    const app = new McpDocsServer({
      index: new DocsIndex(chunks),
      metadata,
      customTools: [{
        name: "client_info_check",
        description: "Checks clientInfo",
        inputSchema: { type: "object", properties: {} },
        handler: async (_args, ctx) => {
          receivedClientInfo = ctx.clientInfo;
          return { content: [{ type: "text" as const, text: "ok" }], isError: false };
        }
      }]
    });

    const handle = await startHttpServer(app, { port: 0 });

    try {
      const addr = handle.httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : handle.port;
      const url = new URL(`http://localhost:${port}/mcp`);

      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: "test-client", version: "0.1.0" });
      await client.connect(transport);

      await client.callTool({ name: "client_info_check", arguments: {} });
      expect(receivedClientInfo).toEqual({ name: "test-client", version: "0.1.0" });

      await client.close();
    } finally {
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()));
    }
  });
});
