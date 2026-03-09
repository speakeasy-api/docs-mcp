import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HandleRequestOptions,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo, BuildInfo } from "./types.js";
import {
  H3,
  handleCors,
  onError,
  toNodeHandler,
  noContent,
  Middleware,
  H3Event,
  defineHandler,
  toResponse,
} from "h3";

const AUTH_INFO = Symbol("authInfo");
const DOCS_MCP_HEADER = "DOCS-MCP";

export type Authenticator = (request: { headers: Headers }) => AuthInfo | Promise<AuthInfo>;

export interface StartHttpServerOptions {
  buildInfo: BuildInfo;
  port?: number;
  /**
   * Async hook called before each request is processed.
   * Receives the HTTP request; return AuthInfo to attach to the request context,
   * or throw to reject with 401.
   */
  authenticate?: Authenticator;
}

export interface HttpServerHandle {
  httpServer: http.Server;
  fetch: (request: Request) => Response | Promise<Response>;
  port: number;
}

interface SessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

class SessionManager {
  private static readonly MAX_SESSIONS = 10_000;
  private sessions = new Map<string, SessionEntry>();

  add(
    sessionId: string,
    server: McpServer,
    transport: WebStandardStreamableHTTPServerTransport,
  ): void {
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
): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
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
  options: StartHttpServerOptions,
): Promise<HttpServerHandle> {
  const port = options.port ?? 20310;
  const sessionManager = new SessionManager();

  const app = new H3()
    .use(createBuildInfoMiddleware(options.buildInfo))
    .use(createErrorMiddleware())
    .use(createCORSMiddleware())
    .get("/healthz", handleHealthCheck(options.buildInfo))
    .delete("/mcp", handleDeleteMCPSession({ sessionManager, authenticate: options.authenticate }))
    .post("/mcp", handleMCPRPC({ factory, sessionManager, authenticate: options.authenticate }));

  const httpServer = http.createServer(toNodeHandler(app));
  httpServer.on("close", () => {
    sessionManager.closeAll();
  });

  const actualPort = await listenOnAvailablePort(httpServer, port);
  console.error(`MCP HTTP server listening on http://localhost:${actualPort}/mcp`);

  return { httpServer, fetch: app.fetch, port: actualPort };
}

function createAuthMiddleware(deps: { handler?: Authenticator }): Middleware {
  const { handler } = deps;
  return async (event, next) => {
    if (handler == null) {
      return await next();
    }

    try {
      const authInfo = await handler({ headers: event.req.headers });
      event.context.authInfo = { ...authInfo, [AUTH_INFO]: true };
    } catch (error) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: error instanceof Error ? error.message : "Unauthorized" },
          id: null,
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    return await next();
  };
}

const createBuildInfoMiddleware = (buildInfo: BuildInfo): Middleware => {
  return (event) => {
    event.res.headers.set(DOCS_MCP_HEADER, makeBuildInfoHeader(buildInfo));
  };
};

const createErrorMiddleware = () => {
  return onError((err) => {
    console.error("Unhandled error in HTTP server:", err);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
    return new Response(body, {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  });
};

const createCORSMiddleware = (): Middleware => {
  return async (event) => {
    const corsRes = handleCors(event, {
      origin: "*",
      allowHeaders: "*",
      methods: ["POST", "DELETE", "OPTIONS"],
      exposeHeaders: [DOCS_MCP_HEADER],
      maxAge: "86400",
      preflight: {
        statusCode: 204,
      },
    });
    if (corsRes !== false) {
      return corsRes;
    }
  };
};

function createDisposeMiddleware(): Middleware {
  return async (event, next) => {
    const disposeCallbacks: Array<() => Promise<void>> = [];
    event.context.disposeCallbacks = disposeCallbacks;
    event.context.queueDispose = (cb: () => Promise<void>) => disposeCallbacks.push(cb);

    let response: Response;
    try {
      const result = await next();
      response = await toResponse(result, event);
    } finally {
      await Promise.allSettled(disposeCallbacks.map((cb) => cb()));
    }

    return response;
  };
}

function queueDispose(event: H3Event, func: () => Promise<void>) {
  const { queueDispose } = event.context;
  if (typeof queueDispose !== "function") {
    throw new Error("Dispose queue not found in event context");
  }

  queueDispose(func);
}

const handleHealthCheck = (buildInfo: BuildInfo) => {
  return defineHandler(() => {
    return { build: buildInfo };
  });
};

const handleDeleteMCPSession = (deps: {
  sessionManager: SessionManager;
  authenticate?: Authenticator | undefined;
}) => {
  return defineHandler({
    middleware: [createAuthMiddleware({ handler: deps.authenticate })],
    handler: async (event) => {
      const { req } = event;
      const authInfo = pullAuthInfo(event);
      const sessionId = req.headers.get("mcp-session-id");
      if (!sessionId) {
        return noContent();
      }
      const entry = deps.sessionManager.get(sessionId);
      if (!entry) {
        return noContent();
      }

      const mcpRes = await entry.transport.handleRequest(req, { authInfo });
      if (mcpRes.ok) {
        deps.sessionManager.evict(sessionId);
      }

      return mcpRes;
    },
  });
};

const handleMCPRPC = (deps: {
  factory: () => McpServer;
  sessionManager: SessionManager;
  authenticate?: Authenticator | undefined;
}) => {
  return defineHandler({
    middleware: [createDisposeMiddleware(), createAuthMiddleware({ handler: deps.authenticate })],
    handler: async (event) => {
      const { req } = event;

      const authInfo = pullAuthInfo(event);
      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId) {
        const entry = deps.sessionManager.get(sessionId);
        if (entry) {
          return await entry.transport.handleRequest(req, { authInfo });
        }
        const { response, dispose } = await handleWithStatelessServer(deps.factory, req, {
          authInfo,
        });
        queueDispose(event, dispose);
        return response;
      }

      const server = deps.factory();
      const transport = createStatefulTransport(server, deps.sessionManager);
      try {
        await server.connect(transport);
        return await transport.handleRequest(req, { authInfo });
      } catch (error) {
        console.error("Error handling MCP request:", error);

        await transport.close().catch(() => {});
        await server.close().catch(() => {});

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    },
  });
};

async function handleWithStatelessServer(
  factory: () => McpServer,
  req: Request,
  options?: HandleRequestOptions,
): Promise<{ response: Response; dispose: () => Promise<void> }> {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = factory();

  await server.connect(transport);
  return {
    response: await transport.handleRequest(req, options),
    dispose: async () => {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
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

function makeBuildInfoHeader(buildInfo: BuildInfo): string {
  const arr: string[] = [];
  arr.push(`name=${buildInfo.name}`);
  arr.push(`version=${buildInfo.version}`);
  if (buildInfo.gitCommit) arr.push(`git=${buildInfo.gitCommit}`);
  if (buildInfo.buildDate) arr.push(`date=${buildInfo.buildDate}`);

  return arr.join(" ");
}

function pullAuthInfo(event: H3Event): AuthInfo | undefined {
  const { authInfo } = event.context;
  if (authInfo == null || typeof authInfo !== "object" || !(AUTH_INFO in authInfo)) {
    return undefined;
  }

  return authInfo as unknown as AuthInfo;
}
