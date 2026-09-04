# @speakeasy-api/docs-mcp-server

MCP server runtime exposing hybrid search over documentation via HTTP and stdio transports.

**Beta.** Part of the [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp) monorepo.

## Installation

```bash
npm install -g @speakeasy-api/docs-mcp-server
```

## CLI Usage

```bash
# HTTP transport
docs-mcp-server --index-dir ./dist/.lancedb --transport http --port 20310

# Stdio transport (for MCP host integration)
docs-mcp-server --index-dir ./dist/.lancedb --transport stdio
```

## Security

Every request's `Origin` header is validated, as the Streamable HTTP transport
requires: a request without one (any non-browser client) passes, a request
whose `Origin` is not allowed is answered with `403` and a JSON-RPC error body.
By default only localhost origins are allowed. Browser-served clients on other
origins need `allowedOrigins` (CLI: `--allowed-origins app.example,...`, env:
`ALLOWED_ORIGINS`), which replaces the localhost default.

The server binds every interface by default, which suits containers and
reverse proxies. When running locally, bind loopback as the spec recommends
(`host: "127.0.0.1"`, CLI: `--host 127.0.0.1`, env: `HOST`); a loopback bind
also validates the `Host` header, so a page that resolves its own domain to
`127.0.0.1` (DNS rebinding) cannot reach the server.

## Errors

Protocol errors are JSON-RPC errors: an unknown tool, an unknown prompt, a
missing required prompt argument, an invalid resource URI and a missing
resource all answer `-32602` (Invalid params); a method outside the declared
capabilities answers `-32601` (Method not found). Tool execution failures,
including rejected tool arguments and errors thrown by custom tool handlers,
are tool results with `isError: true` so the model can recover.

## Capabilities

`tools` is always declared. `prompts` is declared only when the corpus defines
prompts and `resources` only when a taxonomy value is marked with
`mcp_resource: true`. `prompts/list`, `resources/list` and
`resources/templates/list` still answer an empty list when their capability is
not declared, for clients that ask without checking; `prompts/get` and
`resources/read` answer `-32602` for anything not listed. `subscriptions/listen`
on the 2026-07-28 revision is acknowledged with an empty filter and completed
at once, because the server never emits change notifications.

## Protocol revisions

Both transports serve the `2026-07-28` MCP revision (per-request `_meta` envelope,
`server/discover`, no `initialize` handshake) and every 2025-era revision from
`2024-11-05` to `2025-11-25` (the `initialize` handshake) from the same server.
Over HTTP a 2026-07-28 request is always served per request; 2025-era requests
use sessions unless [stateless mode](#stateless-http-mode) is on. Over stdio the
opening message pins the connection to one era. List results on 2026-07-28
carry cache hints (`ttlMs`, `cacheScope`); see `cacheHints` in `createMcpServer`
to change the defaults.

## Programmatic Usage

### Boot with defaults

```typescript
import { createDocsServer, startStdioServer } from "@speakeasy-api/docs-mcp-server";

const server = await createDocsServer({ indexDir: "./my-index" });
await startStdioServer(server);
```

### Inject a custom tool

```typescript
import { createDocsServer, startStdioServer } from "@speakeasy-api/docs-mcp-server";

const server = await createDocsServer({
  indexDir: "./my-index",
  customTools: [
    {
      name: "submit_feedback",
      description: "Submit user feedback about a doc page",
      inputSchema: {
        type: "object",
        properties: {
          chunk_id: { type: "string" },
          rating: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["chunk_id", "rating"],
      },
      handler: async (args) => {
        console.log("Feedback:", args);
        return { content: [{ type: "text", text: "Thanks!" }], isError: false };
      },
    },
  ],
});
await startStdioServer(server);
```

### Run over HTTP

```typescript
import { createDocsServer, startHttpServer } from "@speakeasy-api/docs-mcp-server";

const server = await createDocsServer({ indexDir: "./my-index" });
const { port } = await startHttpServer(server, { port: 3000 });
console.log(`Listening on http://localhost:${port}/mcp`);
```

`createDocsServer()` and `startHttpServer()` share the same defaults as the CLI:

- `serverName` defaults to `SERVER_NAME`, then `@speakeasy-api/docs-mcp-server`, or `${toolPrefix}-docs-server` when only `toolPrefix` is provided.
- `serverVersion` defaults to `SERVER_VERSION`, then the package version.
- HTTP build metadata also picks up `GIT_COMMIT` and `BUILD_DATE` when present.
- Both work without an explicit logger. If you do pass one, a plain `console`-shaped logger is enough.

### HTTP authentication

The `authenticate` hook runs before each request. Return `AuthInfo` to attach
caller identity to the request context, or throw to reject with 401.

```typescript
import { createDocsServer, startHttpServer } from "@speakeasy-api/docs-mcp-server";
import type { AuthInfo } from "@speakeasy-api/docs-mcp-server";

const server = await createDocsServer({
  indexDir: "./my-index",
  customTools: [
    {
      name: "whoami",
      description: "Return the authenticated caller's client ID",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, context) => ({
        content: [{ type: "text", text: `You are: ${context.authInfo?.clientId ?? "unknown"}` }],
        isError: false,
      }),
    },
  ],
});

await startHttpServer(server, {
  port: 3000,
  authenticate: async ({ headers }) => {
    const token = (headers.authorization as string | undefined)?.replace("Bearer ", "");
    if (!token) throw new Error("Missing bearer token");
    // Validate the token and return AuthInfo
    return { token, clientId: "my-client", scopes: ["read"] };
  },
});
```

Custom tool handlers receive a `ToolCallContext` with `authInfo`, `headers`,
`clientInfo` (from the `initialize` handshake on 2025-era connections or the
per-request envelope on 2026-07-28; best-effort and may be missing in
stateless/degraded handling), and an abort `signal`.

### Stateless HTTP mode

Pass `stateless: true` (CLI: `--stateless`, env: `STATELESS=true`) to serve
every 2025-era request with a fresh server and transport. No sessions are
created, the `mcp-session-id` request header is ignored, no `Mcp-Session-Id`
response header is issued, and `DELETE /mcp` responds 405. Use this when
requests may hit different replicas, e.g. behind a load balancer. `GET /mcp`
responds 405 in both modes: the server never opens the 2025-era standalone
notification stream.

## Option Reference

| Field                     | Type           | Default              | Description                                                                                                                                                            |
| ------------------------- | -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexDir`                | `string`       | _required_           | Directory containing `chunks.json` and `metadata.json` from `docs-mcp build`.                                                                                          |
| `toolPrefix`              | `string`       | —                    | Prefix for built-in tool names, e.g. `"acme"` → `acme_search_docs`. Does not affect custom tool names. Alphanumeric, dash, or underscore.                              |
| `queryEmbeddingApiKey`    | `string`       | `OPENAI_API_KEY` env | API key for query-time embeddings.                                                                                                                                     |
| `queryEmbeddingBaseUrl`   | `string`       | Provider default     | Base URL for the embedding API. Defaults to the provider's official endpoint (e.g. `https://api.openai.com/v1` for OpenAI). Override to use a proxy or compatible API. |
| `queryEmbeddingBatchSize` | `number`       | `128`                | Number of texts per embedding API call. Reduce if hitting provider rate or payload limits. Positive integer.                                                           |
| `proximityWeight`         | `number`       | `1.25`               | RRF blend weight for lexical phrase-proximity matches. Higher values boost results where query terms appear close together. Positive.                                  |
| `phraseSlop`              | `number`       | `0`                  | Maximum word distance allowed for phrase matches (0 = exact phrase only, up to 5).                                                                                     |
| `vectorWeight`            | `number`       | `1`                  | RRF blend weight for vector (semantic) search results. Higher values boost semantically similar results. Positive.                                                     |
| `customTools`             | `CustomTool[]` | `[]`                 | Additional tools registered alongside the built-in `search_docs` and `get_doc`.                                                                                        |

The exported `CreateDocsServerOptionsSchema` (Zod) is the canonical machine-readable spec for these options.

## MCP Tools

| Tool          | Description                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Hybrid search with dynamically generated parameters and JSON Schema enum validation. Supports cursor pagination. |
| `get_doc`     | Retrieve a specific chunk with optional neighboring context.                                                     |

Tool names, descriptions, and parameters are dynamically generated from the `metadata.json` produced during indexing.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
