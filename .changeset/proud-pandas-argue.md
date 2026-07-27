---
"@speakeasy-api/docs-mcp-server": minor
---

Add a stateless HTTP mode via `startHttpServer({ stateless: true })` and the `--stateless` CLI flag (env: `STATELESS`).

When enabled, every request is served by a fresh server and transport: no sessions are created, the `mcp-session-id` request header is ignored, no `Mcp-Session-Id` response header is issued, and `DELETE /mcp` responds 405.
