---
"@speakeasy-api/docs-mcp-server": patch
---

Answer `GET /mcp` with 405 and an `Allow` header instead of the router's 404, and serve requests whose `MCP-Protocol-Version` header declares a revision newer than the bundled SDK supports at the newest supported revision instead of rejecting them with 400.
