---
"@speakeasy-api/docs-mcp-server": patch
---

Implement resource listing handlers to work around a Codex bug (openai/codex#8565) that is expecting to successfully call resources/list regardless of whether a server exposes any resources or not.
