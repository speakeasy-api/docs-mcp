# @speakeasy-api/docs-mcp-server

## 0.7.0

### Minor Changes

- bb9e8d6: Added support for setting MCP server instructions using the manifest. It is collected at build time and exposed when MCP clients call the initialize RPC method against the server.

### Patch Changes

- de3f4c9: Fixed lint and test errors
- Updated dependencies [bb9e8d6]
- Updated dependencies [de3f4c9]
  - @speakeasy-api/docs-mcp-core@0.7.0

## 0.6.0

### Minor Changes

- 4f93b52: Added support for exposing documents as MCP resources that can be added into agent context.

### Patch Changes

- Updated dependencies [4f93b52]
  - @speakeasy-api/docs-mcp-core@0.6.0

## 0.5.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.5.0

## 0.4.2

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.2

## 0.4.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.1

## 0.4.0

### Minor Changes

- b7c1bb7: Add clean programmatic API: `createDocsServer()` factory, `ToolProvider` interface, custom tool support, and Zod-validated options schema

### Patch Changes

- c0da9f2: Implement resource listing handlers to work around a Codex bug (openai/codex#8565) that is expecting to successfully call resources/list regardless of whether a server exposes any resources or not.
  - @speakeasy-api/docs-mcp-core@0.4.0

## 0.3.0

### Patch Changes

- 029ec37: Add agent evaluation harness for end-to-end testing of MCP tool usage

  Introduces a self-contained agent eval framework that uses Claude Agent SDK to run realistic coding scenarios against docs-mcp, with assertion-based scoring, file content validation, and an interactive CLI (`docs-mcp-eval`). Includes multi-language scenarios for several SDKs, build caching, history tracking, and configurable tool descriptions in the server.

- Updated dependencies [029ec37]
  - @speakeasy-api/docs-mcp-core@0.3.0

## 0.2.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.2.1

## 0.2.0

### Minor Changes

- 9998fcd: Add `taxonomy` manifest field with `vector_collapse` option for collapsing content-equivalent search results across variant axes (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity are collapsed to the highest-scoring variant. On a realistic 30MB multi-language corpus this improved facet precision by 27%, MRR@5 by 10%, and NDCG@5 by 15%.

### Patch Changes

- Updated dependencies [2d6675d]
- Updated dependencies [df2c538]
- Updated dependencies [9998fcd]
  - @speakeasy-api/docs-mcp-core@0.2.0
