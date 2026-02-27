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
          rating: { type: "integer", minimum: 1, maximum: 5 }
        },
        required: ["chunk_id", "rating"]
      },
      handler: async (args) => {
        console.log("Feedback:", args);
        return { content: [{ type: "text", text: "Thanks!" }], isError: false };
      }
    }
  ]
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
        isError: false
      })
    }
  ]
});

await startHttpServer(server, {
  port: 3000,
  authenticate: async ({ headers }) => {
    const token = (headers.authorization as string | undefined)?.replace("Bearer ", "");
    if (!token) throw new Error("Missing bearer token");
    // Validate the token and return AuthInfo
    return { token, clientId: "my-client", scopes: ["read"] };
  }
});
```

Custom tool handlers receive a `ToolCallContext` with `authInfo`, `headers`,
`clientInfo` (stdio only), and an abort `signal`.

## Option Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `indexDir` | `string` | *required* | Directory containing `chunks.json` and `metadata.json` from `docs-mcp build`. |
| `toolPrefix` | `string` | — | Prefix for tool names, e.g. `"acme"` → `acme_search_docs`. Alphanumeric, dash, or underscore. |
| `queryEmbeddingApiKey` | `string` | `OPENAI_API_KEY` env | API key for query-time embeddings. |
| `queryEmbeddingBaseUrl` | `string` | — | Base URL for the embedding API. |
| `queryEmbeddingBatchSize` | `number` | — | Batch size for query embedding requests. Positive integer. |
| `proximityWeight` | `number` | — | Lexical phrase blend weight for RRF ranking. Positive. |
| `phraseSlop` | `number` | — | Phrase query slop (0–5). |
| `vectorWeight` | `number` | — | Vector rank blend weight for RRF ranking. Positive. |
| `allowChunksFallback` | `boolean` | `false` | Allow fallback to in-memory `chunks.json` when `.lancedb` index is missing. |
| `customTools` | `CustomTool[]` | `[]` | Additional tools registered alongside the built-in `search_docs` and `get_doc`. |

The exported `CreateDocsServerOptionsSchema` (Zod) is the canonical machine-readable spec for these options.

## MCP Tools

| Tool          | Description                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Hybrid search with dynamically generated parameters and JSON Schema enum validation. Supports cursor pagination. |
| `get_doc`     | Retrieve a specific chunk with optional neighboring context.                                                     |

Tool names, descriptions, and parameters are dynamically generated from the `metadata.json` produced during indexing.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
