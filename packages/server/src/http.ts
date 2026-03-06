import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "./types.js";

export interface StartHttpServerOptions {
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

  async evict(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.sessions.delete(sessionId);
      await entry.transport.close().catch(() => {});
      await entry.server.close().catch(() => {});
    }
  }
}

function createStatefulTransport(
  server: McpServer,
  sessionManager: SessionManager,
): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid: string) => {
      sessionManager.add(sid, server, transport);
    },
    onsessionclosed: async (sid: string) => {
      await sessionManager.evict(sid);
    },
  });

  return transport;
}

export async function startHttpServer(
  factory: () => McpServer,
  options: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const port = options.port ?? 20310;
  const sessionManager = new SessionManager();

  const httpServer = http.createServer(async (req, res) => {
    try {
      await handleRequest(factory, req, res, options, sessionManager);
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
  factory: () => McpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
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
    await handleWithStatelessServer(factory, req, res, parsed);
    return;
  }

  const server = factory();
  const transport = createStatefulTransport(server, sessionManager);
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

    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function handleWithStatelessServer(
  factory: () => McpServer,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: unknown,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport();
  const server = factory();

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, parsed);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
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
