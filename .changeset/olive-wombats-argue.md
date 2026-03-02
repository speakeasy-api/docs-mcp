---
"@speakeasy-api/docs-mcp-server": minor
---

Improve HTTP session resilience and simplify server/type plumbing.

- Make stale/unknown session POST requests degrade to stateless handling so tool calls continue (without session-derived `clientInfo`).
- Keep DELETE semantics while making `DELETE /mcp` idempotent for missing or unknown session IDs (`204` no-op).
- Use `McpServer` consistently and simplify transport typing at connect sites.
- Type tool `inputSchema` directly as `ListToolsResult["tools"][number]["inputSchema"]` and remove schema normalization helpers.
- Simplify session cleanup to a single eviction path and add retry-consistency coverage across active, no-session, and stale-session request flows.
