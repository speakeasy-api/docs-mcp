---
"@speakeasy-api/docs-mcp-server": patch
---

Restore `mcp_resource` filtering for MCP resources.

Documents are now exposed as MCP resources only when they match a taxonomy value
marked with `mcp_resource: true`. If no taxonomy values are marked, no MCP
resources are exposed. This also applies consistently to both resource listing
and resource reads.
