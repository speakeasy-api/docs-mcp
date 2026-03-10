---
"@speakeasy-api/docs-mcp-server": patch
---

Treat blank environment variables as unset when resolving default server metadata.

This fixes cases where `SERVER_NAME`, `SERVER_VERSION`, `GIT_COMMIT`, or `BUILD_DATE`
are present but set to `""` or whitespace, so the server now falls back to the same
defaults it would use if those values were omitted entirely.
