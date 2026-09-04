---
"@speakeasy-api/docs-mcp-server": minor
"@speakeasy-api/docs-mcp-eval": patch
---

Move to the v2 MCP TypeScript SDK and serve the 2026-07-28 protocol revision alongside every 2025-era revision.

- HTTP: 2026-07-28 requests (per-request `_meta` envelope, `server/discover`) are served per request in both modes; 2025-era requests keep sessions unless `stateless` is set. `GET /mcp` answers 405 with an `Allow` header instead of the router's 404.
- stdio: the opening message pins the connection to one protocol era.
- List results on 2026-07-28 carry cache hints; `createMcpServer` accepts `mcp.cacheHints` to change the defaults.
- `createMcpServer` now returns the SDK's low-level `Server`; `startStdioServer` returns only `shutdown`.
- The `--log-level` CLI flag now takes its value (`--log-level warn`); it was declared as a boolean flag.
- The eval runner uses the v2 client package.
