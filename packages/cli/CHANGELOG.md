# @speakeasy-api/docs-mcp-cli

## 0.16.2

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.16.2

## 0.16.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.16.1

## 0.16.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.16.0

## 0.15.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.15.1

## 0.15.0

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

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.11.0

## 0.10.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.10.0

## 0.9.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.9.0

## 0.8.0

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

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [029ec37]
  - @speakeasy-api/docs-mcp-core@0.3.0

## 0.2.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.2.1

## 0.2.0

### Minor Changes

- 9998fcd: Add `taxonomy` manifest field with `vector_collapse` option for collapsing content-equivalent search results across variant axes (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity are collapsed to the highest-scoring variant. On a realistic 30MB multi-language corpus this improved facet precision by 27%, MRR@5 by 10%, and NDCG@5 by 15%.

### Patch Changes

- df2c538: Rename manifest file from `.docs-mcp.json` to avoid clashes in schemastore
- Updated dependencies [2d6675d]
- Updated dependencies [df2c538]
- Updated dependencies [9998fcd]
  - @speakeasy-api/docs-mcp-core@0.2.0
