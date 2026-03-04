import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type GetPromptResult,
  type ListPromptsResult,
  type ListToolsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo, ToolCallContext, ToolProvider } from "./types.js";

const require = createRequire(import.meta.url);
const PKG_VERSION = readPackageVersion();

export interface StartHttpServerOptions {
  name?: string;
  version?: string;
  port?: number;
  /**
   * Async hook called before each request is processed.
   * Receives the HTTP request; return AuthInfo to attach to the request context,
   * or throw to reject with 401.
   */
  authenticate?: (request: {
    headers: Record<string, string | string[] | undefined>;
  }) => AuthInfo | Promise<AuthInfo>;
}

export interface HttpServerHandle {
  httpServer: http.Server;
  port: number;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

class SessionManager {
  private static readonly MAX_SESSIONS = 10_000;
  private sessions = new Map<string, SessionEntry>();

  add(sessionId: string, server: McpServer, transport: StreamableHTTPServerTransport): void {
    if (this.sessions.size >= SessionManager.MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.evict(oldest);
    }
    this.sessions.set(sessionId, {
      server,
      transport,
    });
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.evict(id);
    }
  }

  evict(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      entry.transport.close();
      entry.server.close().catch(() => {});
    }
  }
}

function createMcpServer(
  app: ToolProvider,
  options: StartHttpServerOptions,
  includeClientInfo = true,
): McpServer {
  const instructions = app.getInstructions();
  const server = new McpServer(
    {
      name: options.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.version ?? PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      ...(instructions ? { instructions } : {}),
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = app.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { tools } satisfies ListToolsResult;
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const context: ToolCallContext = { signal: extra.signal };
    if (extra.authInfo) {
      context.authInfo = extra.authInfo;
    }
    if (extra.requestInfo?.headers) {
      context.headers = extra.requestInfo.headers;
    }
    if (includeClientInfo) {
      const clientVersion = server.server.getClientVersion();
      if (clientVersion) {
        context.clientInfo = { name: clientVersion.name, version: clientVersion.version };
      }
    }
    return app.callTool(request.params.name, request.params.arguments ?? {}, context);
  });

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await app.getResources();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        title: r.title,
        description: r.description,
        mimeType: r.mimeType,
      })),
    } satisfies ListResourcesResult;
  });

  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] } satisfies ListResourceTemplatesResult;
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const result = await app.readResource(request.params.uri);
    return result;
  });

  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: app.getPrompts(),
    } satisfies ListPromptsResult;
  });

  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const result = await app.getPrompt(request.params.name, request.params.arguments);
    return result as GetPromptResult;
  });

  return server;
}

function createSessionServer(
  app: ToolProvider,
  options: StartHttpServerOptions,
  sessionManager: SessionManager,
): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const server = createMcpServer(app, options);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid: string) => {
      sessionManager.add(sid, server, transport);
    },
    onsessionclosed: (sid: string) => {
      sessionManager.evict(sid);
    },
  });

  return { server, transport };
}

export async function startHttpServer(
  app: ToolProvider,
  options: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const port = options.port ?? 20310;
  const sessionManager = new SessionManager();

  const httpServer = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, app, options, sessionManager);
    } catch (error) {
      console.error("Unhandled error in request handler:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  httpServer.on("close", () => {
    sessionManager.closeAll();
  });

  const actualPort = await listenOnAvailablePort(httpServer, port);
  console.error(`MCP HTTP server listening on http://localhost:${actualPort}/mcp`);

  return { httpServer, port: actualPort };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function setCorsHeaders(res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: ToolProvider,
  options: StartHttpServerOptions,
  sessionManager: SessionManager,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname !== "/mcp") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }),
    );
    return;
  }

  if (options.authenticate) {
    try {
      const authInfo = await options.authenticate({ headers: req.headers });
      Object.assign(req, { auth: authInfo });
    } catch (error) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: error instanceof Error ? error.message : "Unauthorized" },
          id: null,
        }),
      );
      return;
    }
  }

  // MCP states clients should send DELETE requests for clean shutdown.
  if (req.method === "DELETE") {
    const sessionId = getHeaderValue(req.headers["mcp-session-id"]);
    if (!sessionId) {
      // Idempotent
      res.writeHead(204);
      res.end();
      return;
    }
    const entry = sessionManager.get(sessionId);
    if (!entry) {
      res.writeHead(204);
      res.end();
      return;
    }
    await entry.transport.handleRequest(req, res);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      sessionManager.evict(sessionId);
    }
    return;
  }

  const sessionId = getHeaderValue(req.headers["mcp-session-id"]);

  let parsed: unknown;
  try {
    const body = await readBody(req);
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      }),
    );
    return;
  }

  if (sessionId) {
    const entry = sessionManager.get(sessionId);
    if (entry) {
      await entry.transport.handleRequest(req, res, parsed);
      return;
    }
    await handleWithStatelessServer(req, res, parsed, app, options);
    return;
  }

  const { server, transport } = createSessionServer(app, options, sessionManager);
  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, parsed);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
    transport.close();
    void server.close();
  }
}

async function handleWithStatelessServer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: unknown,
  app: ToolProvider,
  options: StartHttpServerOptions,
): Promise<void> {
  const server = createMcpServer(app, options, false);
  const transport = new StreamableHTTPServerTransport();

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, parsed);
  } finally {
    transport.close();
    void server.close();
  }
}

const MAX_PORT_ATTEMPTS = 10;

/**
 * Try to listen on `startPort`. If the port is busy (EADDRINUSE), try
 * startPort+1, startPort+2, etc. up to MAX_PORT_ATTEMPTS.
 * Port 0 is passed through directly (OS picks an ephemeral port).
 */
function listenOnAvailablePort(server: http.Server, startPort: number): Promise<number> {
  if (startPort === 0) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => {
        server.removeListener("error", reject);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  let attempt = 0;
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      server.once("error", (err: { code?: string }) => {
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
          attempt++;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, () => {
        server.removeAllListeners("error");
        resolve(port);
      });
    };
    tryPort(startPort);
  });
}

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" ? header : undefined;
}

function readPackageVersion(): string {
  const pkg = require("../package.json");
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}
