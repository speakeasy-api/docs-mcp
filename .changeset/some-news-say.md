---
"@speakeasy-api/docs-mcp-playground": minor
"@speakeasy-api/docs-mcp-server": minor
---

Added `GET /healthz` endpoint to server and support for passing build info to server and playground. On the server this build info is included in every http response in the `DOCS-MCP` header and the response body of `GET /healthz`.

Environment variables are:

- `SERVER_NAME`: the name of the MCP server
- `SERVER_VERSION`: the version of the MCP server
- `GIT_COMMIT`: the git commit hash of the current build
- `BUILD_DATE`: the date of the current build
