---
"@speakeasy-api/docs-mcp-server": minor
---

Answer protocol errors with the specification's JSON-RPC codes and validate `Origin` as the Streamable HTTP transport requires:

- Unknown tool, unknown prompt, missing required prompt argument, invalid resource URI and missing resource answer `-32602` (Invalid params). Previously an unknown tool was a tool result with `isError` and the others were `-32603`. Tool execution failures, including rejected tool arguments and errors thrown by custom tool handlers, remain `isError` results.
- The `Origin` header is validated on every HTTP request; a present, disallowed `Origin` answers `403` with a JSON-RPC error body. Localhost origins are allowed by default; `allowedOrigins` (CLI `--allowed-origins`, env `ALLOWED_ORIGINS`) replaces that list.
- New `host` option (CLI `--host`, env `HOST`) selects the bind address. A loopback bind also validates the `Host` header against localhost names. `mise run serve:http` now binds `127.0.0.1`.
