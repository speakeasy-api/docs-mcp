# @speakeasy-api/docs-mcp-server

## 0.15.0

### Minor Changes

- ac6d3a0: Add structured logging for production
- a669636: Added `GET /healthz` endpoint to server and support for passing build info to server and playground. On the server this build info is included in every http response in the `DOCS-MCP` header and the response body of `GET /healthz`.

  Environment variables are:
  - `SERVER_NAME`: the name of the MCP server
  - `SERVER_VERSION`: the version of the MCP server
  - `GIT_COMMIT`: the git commit hash of the current build
  - `BUILD_DATE`: the date of the current build

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.15.0

## 0.14.0

### Minor Changes

- f591bfe: Added MCP prompt template support to docs-mcp: docs authors can now define prompts with \*.template.md (simple single-message prompts) or \*.template.yaml (structured multi-message prompts), with mustache argument rendering at runtime. Prompt templates are excluded from search indexing, surfaced through MCP prompts/list and prompts/get, and when both formats exist for the same prompt name, YAML is preferred with a warning.

### Patch Changes

- Updated dependencies [f591bfe]
  - @speakeasy-api/docs-mcp-core@0.14.0

## 0.13.0

### Minor Changes

- 8a321c5: Extract human-readable titles for MCP resources from markdown files. Titles are resolved using frontmatter `title` with a fallback to the first H1 heading. These titles appear in MCP resource listings, making it easier for agents to identify documents.

### Patch Changes

- Updated dependencies [8a321c5]
  - @speakeasy-api/docs-mcp-core@0.13.0

## 0.12.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.12.1

## 0.12.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.12.0

## 0.11.0

### Minor Changes

- c61ced6: Add tool usage bar chart and feedback tool confidence scoring to agent eval
  - **Tool usage bar chart**: Terminal ASCII bar chart in eval summary showing full tool call distribution (not just MCP tools), with colored bars sorted by count
  - **Feedback tool**: New `--feedback-tool` flag on the server registers a `docs_feedback` tool that agents call to self-report confidence, relevance, and utilization scores (0-100)
  - **Judge mode** (default on): Agent eval automatically enables feedback tool, instructs the agent to call it, extracts scores from tool trace, and displays them in scenario results, summary, and comparison reports. Disable with `--no-judge`

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.11.0

## 0.10.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.10.0

## 0.9.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.9.0

## 0.8.0

### Minor Changes

- 1ce3d2f: Improve HTTP session resilience and simplify server/type plumbing.
  - Make stale/unknown session POST requests degrade to stateless handling so tool calls continue (without session-derived `clientInfo`).
  - Keep DELETE semantics while making `DELETE /mcp` idempotent for missing or unknown session IDs (`204` no-op).
  - Use `McpServer` consistently and simplify transport typing at connect sites.
  - Type tool `inputSchema` directly as `ListToolsResult["tools"][number]["inputSchema"]` and remove schema normalization helpers.
  - Simplify session cleanup to a single eviction path and add retry-consistency coverage across active, no-session, and stale-session request flows.

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.8.0

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
