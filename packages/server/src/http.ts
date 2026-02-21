import http from "node:http";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult
} from "@modelcontextprotocol/sdk/types.js";
import type { McpDocsServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

export interface StartHttpServerOptions {
  name?: string;
  version?: string;
  port?: number;
}

export interface HttpServerHandle {
  httpServer: http.Server;
  port: number;
}

/**
 * Create a fresh MCP Server wired to the given app and return it connected to a
 * new stateless StreamableHTTPServerTransport.  In stateless mode every request
 * gets its own server+transport pair (the SDK examples demonstrate this pattern
 * in `simpleStatelessStreamableHttp.ts`).
 */
function createPerRequestServer(
  app: McpDocsServer,
  options: StartHttpServerOptions
): { server: Server; transport: StreamableHTTPServerTransport } {
  const server = new Server(
    {
      name: options.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.version ?? PKG_VERSION
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = app.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as ListToolsResult["tools"][number]["inputSchema"]
    }));
    return { tools } satisfies ListToolsResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await app.callTool(request.params.name, request.params.arguments ?? {});
    return result as CallToolResult;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exactOptionalPropertyTypes workaround
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
  return { server, transport };
}

export async function startHttpServer(
  app: McpDocsServer,
  options: StartHttpServerOptions = {}
): Promise<HttpServerHandle> {
  const port = options.port ?? 20310;

  const httpServer = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, app, options);
    } catch (error) {
      console.error("Unhandled error in request handler:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null
          })
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  const actualPort = await listenOnAvailablePort(httpServer, port);
  console.error(`MCP HTTP server listening on http://localhost:${actualPort}/mcp`);

  return { httpServer, port: actualPort };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400"
};

function setCorsHeaders(res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: McpDocsServer,
  options: StartHttpServerOptions
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

  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
      })
    );
    return;
  }

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
        id: null
      })
    );
    return;
  }

  const { server, transport } = createPerRequestServer(app, options);
  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, parsed);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        })
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
