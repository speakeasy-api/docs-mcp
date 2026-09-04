---
"@speakeasy-api/docs-mcp-server": patch
---

Protocol hygiene for servers that never change and never notify:

- End every 2026-07-28 `subscriptions/listen` subscription immediately over HTTP: acknowledge with an empty filter, then complete the request and close the stream. This server never emits change notifications, so holding the stream open only pinned a connection per client.
- Declare the `prompts` capability only when the corpus defines prompts and the `resources` capability only when a taxonomy value is marked as an MCP resource. Requests for an undeclared capability answer "Method not found" instead of an empty list, and clients that respect declared capabilities stop sending them.
