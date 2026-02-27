import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo, ToolCallContext, ToolProvider } from "./types.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as {
  version: string;
};

export interface StartHttpServerOptions {
  name?: string;
  version?: string;
  port?: number;
  /**
   * Async hook called before each request is processed.
   * Receives the HTTP request; return AuthInfo to attach to the request context,
   * or throw to reject with 401.
   */
  authenticate?: (request: { headers: Record<string, string | string[] | undefined> }) => AuthInfo | Promise<AuthInfo>;
  /** Idle timeout per session in milliseconds. Sessions with no activity are cleaned up. Default: 600_000 (10 min). */
  sessionTimeoutMs?: number;
  /** Maximum number of concurrent sessions. New sessions are rejected with 503 when at capacity. Default: 100. */
  maxSessions?: number;
}

export interface HttpServerHandle {
  httpServer: http.Server;
  port: number;
}

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages MCP sessions with idle-timeout eviction and a max-sessions cap.
 */
class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private readonly timeoutMs: number;
  private readonly maxSessions: number;

  constructor(timeoutMs: number, maxSessions: number) {
    this.timeoutMs = timeoutMs;
    this.maxSessions = maxSessions;
  }

  get size(): number {
    return this.sessions.size;
  }

  get isFull(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  add(sessionId: string, server: Server, transport: StreamableHTTPServerTransport): void {
    const timer = setTimeout(() => this.evict(sessionId), this.timeoutMs);
    this.sessions.set(sessionId, {
      server,
      transport,
      lastActivity: Date.now(),
      timer,
    });
  }

  get(sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastActivity = Date.now();
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.evict(sessionId), this.timeoutMs);
    }
    return entry;
  }

  peek(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      clearTimeout(entry.timer);
      this.sessions.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const [id, entry] of this.sessions) {
      clearTimeout(entry.timer);
      entry.transport.close();
      entry.server.close();
      this.sessions.delete(id);
    }
  }

  private evict(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      entry.transport.close();
      entry.server.close();
    }
  }
}

/**
 * Create a new MCP Server + StreamableHTTPServerTransport for a new session.
 * The transport uses session IDs so subsequent requests can be routed back.
 */
function createSessionServer(
  app: ToolProvider,
  options: StartHttpServerOptions,
  sessionManager: SessionManager,
): { server: Server; transport: StreamableHTTPServerTransport } {
  const server = new Server(
    {
      name: options.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.version ?? PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = app.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
    }));
    return { tools } satisfies ListToolsResult;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: [] } satisfies ListResourcesResult;
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] } satisfies ListResourceTemplatesResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const context: ToolCallContext = { signal: extra.signal };
    if (extra.authInfo) {
      context.authInfo = extra.authInfo;
    }
    if (extra.requestInfo?.headers) {
      context.headers = extra.requestInfo.headers;
    }
    const clientVersion = server.getClientVersion();
    if (clientVersion) {
      context.clientInfo = { name: clientVersion.name, version: clientVersion.version };
    }
    const result = await app.callTool(request.params.name, request.params.arguments ?? {}, context);
    return result as CallToolResult;
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid: string) => {
      sessionManager.add(sid, server, transport);
    },
    onsessionclosed: (sid: string) => {
      sessionManager.remove(sid);
    },
  });

  return { server, transport };
}

export async function startHttpServer(
  app: ToolProvider,
  options: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const port = options.port ?? 20310;
  const sessionManager = new SessionManager(
    options.sessionTimeoutMs ?? 600_000,
    options.maxSessions ?? 100,
  );

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
  // Only the pathname matters; the base URL is arbitrary.
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
      (req as http.IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
    } catch (error) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: error instanceof Error ? error.message : "Unauthorized" },
          id: null
        })
      );
      return;
    }
  }

  // DELETE requests are forwarded to existing sessions for clean shutdown.
  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing mcp-session-id header" },
          id: null,
        }),
      );
      return;
    }
    const entry = sessionManager.peek(sessionId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found" },
          id: null,
        }),
      );
      return;
    }
    await entry.transport.handleRequest(req, res);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      sessionManager.remove(sessionId);
    }
    return;
  }

  // POST requests — route to existing session or create a new one.
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Parse JSON body before handing off to the transport
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
    // Existing session — look up and forward.
    const entry = sessionManager.get(sessionId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found or expired" },
          id: null,
        }),
      );
      return;
    }
    await entry.transport.handleRequest(req, res, parsed);
    return;
  }

  // New session — enforce max sessions cap.
  if (sessionManager.isFull) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many active sessions" },
        id: null,
      }),
    );
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
    server.close();
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
