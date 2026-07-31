---
"@speakeasy-api/docs-mcp-server": patch
---

Fix stateless HTTP mode truncating async tool call responses. The per-request server and transport were disposed as soon as the request handler returned, closing the SSE stream before asynchronous tool results (such as search) were written to it. Disposal now waits for the response body to complete, error, or be cancelled by the client. This also fixes the same truncation on the stateful server's stale-session fallback path.
