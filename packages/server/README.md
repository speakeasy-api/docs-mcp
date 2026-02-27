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

```typescript
import { McpDocsServer } from "@speakeasy-api/docs-mcp-server";

const server = new McpDocsServer({
  dbPath: "./dist/.lancedb",
});

server.start();
```

## MCP Tools

| Tool          | Description                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Hybrid search with dynamically generated parameters and JSON Schema enum validation. Supports cursor pagination. |
| `get_doc`     | Retrieve a specific chunk with optional neighboring context.                                                     |

Tool names, descriptions, and parameters are dynamically generated from the `metadata.json` produced during indexing.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
