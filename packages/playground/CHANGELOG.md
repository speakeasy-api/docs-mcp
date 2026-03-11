# @speakeasy-api/docs-mcp-playground

## 0.16.3

## 0.16.2

## 0.16.1

## 0.16.0

## 0.15.1

### Patch Changes

- 2d1ddc8: Restored missing server build

## 0.15.0

### Minor Changes

- a669636: Added `GET /healthz` endpoint to server and support for passing build info to server and playground. On the server this build info is included in every http response in the `DOCS-MCP` header and the response body of `GET /healthz`.

  Environment variables are:
  - `SERVER_NAME`: the name of the MCP server
  - `SERVER_VERSION`: the version of the MCP server
  - `GIT_COMMIT`: the git commit hash of the current build
  - `BUILD_DATE`: the date of the current build

## 0.14.0

## 0.13.0

## 0.12.1

### Patch Changes

- 967f398: fix incorrect logo used to represent codex

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

## 0.6.0

### Minor Changes

- bd9980c: Add resources panel to playground UI with expandable markdown previews and extract shared MCP session helpers
- 4f93b52: Added support for exposing documents as MCP resources that can be added into agent context.

## 0.5.0

## 0.4.2

### Patch Changes

- 40dd590: Fix MCP protocol handshake: send initialize/initialized before tools/list and propagate Mcp-Session-Id header

## 0.4.1

### Patch Changes

- ac1c5f3: Fix MCP protocol handshake: send initialize and notifications/initialized before tools/list

## 0.4.0

## 0.3.0

## 0.2.1

### Patch Changes

- 36fdde0: chore: enable model picker in playground

## 0.2.0
