---
"@speakeasy-api/docs-mcp-eval": patch
---

Fix eval usage reporting to fall back to accumulated counts when SDK final values are zero

- Prefer SDK-reported final usage values but fall back to incrementally accumulated counts when they are zero
- Add debug logging for Claude provider result and runner done events
