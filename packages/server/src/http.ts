import crypto from "node:crypto";
import http from "node:http";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  legacyStatelessFallback,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  WebStandardStreamableHTTPServerTransport,
  type Implementation,
  type LegacyHttpHandler,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpServerFactory,
  type Server,
} from "@modelcontextprotocol/server";
import type {
  AuthInfo,
  BuildInfo,
  CreateDocsServerRuntimeOptions,
  DocsServer,
  Logger,
} from "./types.js";
import {
  H3,
  handleCors,
  onError,
  toNodeHandler,
  noContent,
  Middleware,
  H3Event,
  defineHandler,
  bodyLimit,
} from "h3";
import { resolveLogger } from "./logging.js";
import {
  resolveBuildInfo as resolveDefaultBuildInfo,
  resolveServerName,
  resolveServerVersion,
} from "./defaults.js";

const AUTH_INFO = Symbol("authInfo");
const DOCS_MCP_HEADER = "DOCS-MCP";

export type Authenticator = (request: { headers: Headers }) => AuthInfo | Promise<AuthInfo>;

export interface StartHttpServerOptions extends Pick<
  CreateDocsServerRuntimeOptions,
  "logger" | "pretty" | "logLevel"
> {
  buildInfo?: BuildInfo;
  port?: number;
  /**
   * Address to bind. Defaults to every interface, which suits containers and
   * reverse proxies. The spec recommends binding only to localhost when the
   * server runs locally; pass `"127.0.0.1"` for that. A loopback bind also
   * turns on Host header validation, so a page that resolves its own domain
   * to 127.0.0.1 (DNS rebinding) cannot reach the server.
   */
  host?: string;
  /**
   * Hostnames whose `Origin` header is accepted. The spec requires servers to
   * validate `Origin` on every request and answer 403 when it is present and
   * not allowed, so this is always on: requests without an `Origin` header
   * (non-browser clients) pass, and by default only localhost origins are
   * allowed. Set this to the hostnames of browser-served clients that should
   * be able to call the server; it replaces the localhost default.
   */
  allowedOrigins?: string[];
  /**
   * Async hook called before each request is processed.
   * Receives the HTTP request; return AuthInfo to attach to the request context,
   * or throw to reject with 401.
   */
  authenticate?: Authenticator;
  /**
   * Serve every 2025-era request with a fresh server and transport. No
   * sessions are created, the mcp-session-id request header is ignored and no
   * Mcp-Session-Id response header is issued. Requests on the 2026-07-28
   * revision are always served per request, in either mode.
   */
  stateless?: boolean;
}

export interface HttpServerHandle {
  httpServer: http.Server;
  shutdown: () => Promise<void>;
  fetch: (request: Request) => Response | Promise<Response>;
  port: number;
}

export async function startHttpServer(
  factory: (() => Server) | DocsServer,
  options: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const logger = await resolveLogger(options);
  const buildInfo = resolveBuildInfo(factory, options.buildInfo);
  const port = options.port ?? 20310;
  const host = options.host;
  const sessionManager = options.stateless ? undefined : new SessionManager();
  const serverFactory: McpServerFactory = () => factory();
  const onerror = (error: Error) => {
    logger.warn("mcp handler error", { error });
  };

  // The 2026-07-28 revision is served per request from the same factory in
  // both modes. In stateless mode the handler also serves 2025-era requests
  // per request. In session mode 2025-era requests keep the sessionful
  // serving below, so the handler is strict and only ever sees requests
  // carrying the per-request `_meta` envelope.
  const modernEntry = createMcpHandler(serverFactory, {
    legacy: sessionManager ? "reject" : "stateless",
    onerror,
  });
  const modern: McpHttpHandler = {
    ...modernEntry,
    fetch: async (request, requestOptions) =>
      (await declineSubscriptionsListen(request, {
        name: buildInfo.name,
        version: buildInfo.version,
      })) ?? modernEntry.fetch(request, requestOptions),
  };
  const legacyFallback = legacyStatelessFallback(serverFactory, onerror);

  const app = new H3()
    .use(bodyLimit(50 * 1024 * 1024))
    .use(createLogMiddleware(logger))
    .use(createBuildInfoMiddleware(buildInfo))
    .use(createErrorMiddleware({ logger }))
    .use(createCORSMiddleware())
    .use(createOriginValidationMiddleware(options.allowedOrigins ?? localhostAllowedOrigins()))
    .use(createHostValidationMiddleware(host))
    .get("/healthz", handleHealthCheck(buildInfo))
    .get("/mcp", handleGetMCPStream({ allow: sessionManager ? "POST, DELETE" : "POST" }))
    .delete(
      "/mcp",
      sessionManager
        ? handleDeleteMCPSession({ sessionManager, authenticate: options.authenticate })
        : handleDeleteMCPSessionStateless(),
    )
    .post(
      "/mcp",
      sessionManager
        ? handleMCPRPC({
            logger,
            factory,
            sessionManager,
            modern,
            legacyFallback,
            authenticate: options.authenticate,
          })
        : handleMCPRPCStateless({ modern, authenticate: options.authenticate }),
    );

  const httpServer = http.createServer(toNodeHandler(app));
  httpServer.on("close", () => {
    sessionManager?.closeAll();
    void modern.close();
  });

  const actualPort = await listenOnAvailablePort(httpServer, port, host);
  logger.info("started mcp server", {
    url: `http://${host ?? "localhost"}:${actualPort}/mcp`,
    ...(host ? {} : { bind: "all interfaces" }),
  });

  const shutdown = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      logger.info("shutting down http server");

      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  return { httpServer, fetch: app.fetch, port: actualPort, shutdown };
}

interface SessionEntry {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

class SessionManager {
  private static readonly MAX_SESSIONS = 10_000;
  private sessions = new Map<string, SessionEntry>();

  add(
    sessionId: string,
    server: Server,
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
  server: Server,
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

const createLogMiddleware = (logger: Logger): Middleware => {
  return async (event, next) => {
    const start = process.hrtime();
    try {
      logger.debug("request", {
        method: event.req.method,
        path: event.url.pathname,
      });
      return await next();
    } finally {
      const duration = process.hrtime(start);
      const ms = duration[0] * 1000 + duration[1] / 1_000_000;
      logger.info("response", {
        method: event.req.method,
        path: event.url.pathname,
        duration_ms: Number(ms.toFixed(2)),
      });
    }
  };
};

const createBuildInfoMiddleware = (buildInfo: BuildInfo): Middleware => {
  return (event) => {
    event.res.headers.set(DOCS_MCP_HEADER, makeBuildInfoHeader(buildInfo));
  };
};

const createErrorMiddleware = (options: { logger: Logger }) => {
  return onError((err) => {
    const { logger } = options;

    logger.error("unhandled error", { error: err });
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

/**
 * Streamable HTTP security requirement: validate `Origin` on every request and
 * answer 403 when it is present and not allowed. Requests without an `Origin`
 * header pass. The response body is the SDK's JSON-RPC error without an id.
 */
const createOriginValidationMiddleware = (allowedOriginHostnames: string[]): Middleware => {
  return (event) => originValidationResponse(event.req, allowedOriginHostnames);
};

/**
 * Host header validation for loopback binds. A server reachable only on
 * localhost is the DNS rebinding target the spec describes; refusing any
 * other `Host` closes that door. Off for other binds, where the `Host` header
 * legitimately names the service (containers, reverse proxies).
 */
const createHostValidationMiddleware = (host: string | undefined): Middleware => {
  if (!host || !isLoopbackAddress(host)) {
    return () => undefined;
  }
  const allowed = localhostAllowedHostnames();
  return (event) => hostHeaderValidationResponse(event.req, allowed);
};

function isLoopbackAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";

/**
 * Ends a 2026-07-28 `subscriptions/listen` subscription immediately.
 *
 * This server never emits a change notification: the corpus is fixed for the
 * lifetime of the process and no `listChanged` or `subscribe` capability is
 * advertised, so the acknowledged filter is always empty. The SDK entry would
 * still hold the stream open until the client goes away, which pins a
 * connection (and, behind a tunnel, a multiplexed stream slot) that can never
 * carry anything. The spec lets a server end a subscription on its own
 * initiative: acknowledge, then answer the `subscriptions/listen` request with
 * a completion result and close the stream. Clients treat that as a clean
 * close rather than a disconnect to retry.
 *
 * Only a well-formed modern request is answered here. Anything else (no
 * per-request envelope, missing `Mcp-Method` header, no `notifications`
 * filter) falls through to the SDK entry, which owns those rejections.
 */
async function declineSubscriptionsListen(
  request: Request,
  serverInfo: Implementation,
): Promise<Response | undefined> {
  if (request.method !== "POST") {
    return undefined;
  }
  if (request.headers.get("mcp-method") !== SUBSCRIPTIONS_LISTEN_METHOD) {
    return undefined;
  }

  let message: unknown;
  try {
    message = await request.clone().json();
  } catch {
    return undefined;
  }
  if (!isModernListenRequest(message)) {
    return undefined;
  }

  const subscriptionId = message.id;
  const acknowledged = {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      notifications: {},
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
    },
  };
  const completed = {
    jsonrpc: "2.0",
    id: subscriptionId,
    result: {
      resultType: "complete",
      _meta: {
        [SUBSCRIPTION_ID_META_KEY]: subscriptionId,
        [SERVER_INFO_META_KEY]: serverInfo,
      },
    },
  };
  const body = [acknowledged, completed]
    .map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

interface ModernListenRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: typeof SUBSCRIPTIONS_LISTEN_METHOD;
  params: { notifications: Record<string, unknown>; _meta: Record<string, unknown> };
}

function isModernListenRequest(message: unknown): message is ModernListenRequest {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const { jsonrpc, id, method, params } = message as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SUBSCRIPTIONS_LISTEN_METHOD) {
    return false;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return false;
  }
  if (!params || typeof params !== "object") {
    return false;
  }
  const { notifications, _meta } = params as Record<string, unknown>;
  if (!notifications || typeof notifications !== "object" || Array.isArray(notifications)) {
    return false;
  }
  if (!_meta || typeof _meta !== "object") {
    return false;
  }
  return typeof (_meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY] === "string";
}

const handleHealthCheck = (buildInfo: BuildInfo) => {
  return defineHandler(() => {
    return { build: buildInfo };
  });
};

/**
 * This server never opens the 2025-era standalone server-to-client SSE
 * stream, so a GET on the MCP endpoint is answered with 405 and an Allow
 * header as the Streamable HTTP transport spec requires. Without an explicit
 * route the request would fall through to the router's 404, which is not a
 * JSON-RPC response and echoes the bound URL back to the caller. The
 * 2026-07-28 revision has no GET at all: change notifications ride
 * `subscriptions/listen`, a POST.
 */
const handleGetMCPStream = (deps: { allow: string }) => {
  return defineHandler(() => {
    return new Response(null, { status: 405, headers: { Allow: deps.allow } });
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
      const requestOptions = mcpRequestOptions(event);
      const sessionId = req.headers.get("mcp-session-id");
      if (!sessionId) {
        return noContent();
      }
      const entry = deps.sessionManager.get(sessionId);
      if (!entry) {
        return noContent();
      }

      const mcpRes = await entry.transport.handleRequest(req, requestOptions);
      if (mcpRes.ok) {
        deps.sessionManager.evict(sessionId);
      }

      return mcpRes;
    },
  });
};

const handleDeleteMCPSessionStateless = () => {
  return defineHandler(() => {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  });
};

const handleMCPRPC = (deps: {
  logger: Logger;
  factory: () => Server;
  sessionManager: SessionManager;
  modern: McpHttpHandler;
  legacyFallback: LegacyHttpHandler;
  authenticate?: Authenticator | undefined;
}) => {
  return defineHandler({
    middleware: [createAuthMiddleware({ handler: deps.authenticate })],
    handler: async (event) => {
      const { logger } = deps;
      const { req } = event;
      const requestOptions = mcpRequestOptions(event);

      // Requests carrying the 2026-07-28 per-request envelope never belong to
      // a session; everything else is a 2025-era request and keeps the
      // sessionful serving.
      if (!(await isLegacyRequest(req))) {
        return await deps.modern.fetch(req, requestOptions);
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId) {
        const entry = deps.sessionManager.get(sessionId);
        if (entry) {
          return await entry.transport.handleRequest(req, requestOptions);
        }

        logger.warn("no session state found for session id", { session_id: sessionId });
        return await deps.legacyFallback(req, requestOptions);
      }

      const server = deps.factory();
      const transport = createStatefulTransport(server, deps.sessionManager);
      try {
        await server.connect(transport);
        return await transport.handleRequest(req, requestOptions);
      } catch (error) {
        logger.error("error handling mcp request", { error });

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

const handleMCPRPCStateless = (deps: {
  modern: McpHttpHandler;
  authenticate?: Authenticator | undefined;
}) => {
  return defineHandler({
    middleware: [createAuthMiddleware({ handler: deps.authenticate })],
    handler: async (event) => {
      return await deps.modern.fetch(event.req, mcpRequestOptions(event));
    },
  });
};

const MAX_PORT_ATTEMPTS = 10;

/**
 * Try to listen on `startPort`. If the port is busy (EADDRINUSE), try
 * startPort+1, startPort+2, etc. up to MAX_PORT_ATTEMPTS.
 * Port 0 is passed through directly (OS picks an ephemeral port).
 */
function listenOnAvailablePort(
  server: http.Server,
  startPort: number,
  host?: string,
): Promise<number> {
  if (startPort === 0) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.removeListener("error", reject);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
  }

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = (port: number) => {
      const onError = (err: Error & { code?: string }) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
          attempt++;
          tryListen(port + 1);
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        server.removeListener("error", onError);
        resolve(port);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };

    tryListen(startPort);
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

function mcpRequestOptions(event: H3Event): McpHandlerRequestOptions {
  const authInfo = pullAuthInfo(event);
  return authInfo ? { authInfo } : {};
}

function pullAuthInfo(event: H3Event): AuthInfo | undefined {
  const { authInfo } = event.context;
  if (authInfo == null || typeof authInfo !== "object" || !(AUTH_INFO in authInfo)) {
    return undefined;
  }

  return authInfo as unknown as AuthInfo;
}

function resolveBuildInfo(factory: (() => Server) | DocsServer, buildInfo?: BuildInfo): BuildInfo {
  if (buildInfo) {
    return buildInfo;
  }
  if ("buildInfo" in factory) {
    return factory.buildInfo;
  }
  return {
    ...resolveDefaultBuildInfo({
      name: resolveServerName(),
      version: resolveServerVersion(),
    }),
  };
}
