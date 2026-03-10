# @speakeasy-api/docs-mcp-core

## 0.16.0

## 0.15.1

## 0.15.0

## 0.14.0

### Minor Changes

- f591bfe: Added MCP prompt template support to docs-mcp: docs authors can now define prompts with \*.template.md (simple single-message prompts) or \*.template.yaml (structured multi-message prompts), with mustache argument rendering at runtime. Prompt templates are excluded from search indexing, surfaced through MCP prompts/list and prompts/get, and when both formats exist for the same prompt name, YAML is preferred with a warning.

## 0.13.0

### Minor Changes

- 8a321c5: Extract human-readable titles for MCP resources from markdown files. Titles are resolved using frontmatter `title` with a fallback to the first H1 heading. These titles appear in MCP resource listings, making it easier for agents to identify documents.

## 0.12.1

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

### Minor Changes

- bb9e8d6: Added support for setting MCP server instructions using the manifest. It is collected at build time and exposed when MCP clients call the initialize RPC method against the server.

### Patch Changes

- de3f4c9: Fixed lint and test errors

## 0.6.0

### Minor Changes

- 4f93b52: Added support for exposing documents as MCP resources that can be added into agent context.

## 0.5.0

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.0

### Patch Changes

- 029ec37: Add agent evaluation harness for end-to-end testing of MCP tool usage

  Introduces a self-contained agent eval framework that uses Claude Agent SDK to run realistic coding scenarios against docs-mcp, with assertion-based scoring, file content validation, and an interactive CLI (`docs-mcp-eval`). Includes multi-language scenarios for several SDKs, build caching, history tracking, and configurable tool descriptions in the server.

## 0.2.1

## 0.2.0

### Minor Changes

- 9998fcd: Add `taxonomy` manifest field with `vector_collapse` option for collapsing content-equivalent search results across variant axes (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity are collapsed to the highest-scoring variant. On a realistic 30MB multi-language corpus this improved facet precision by 27%, MRR@5 by 10%, and NDCG@5 by 15%.

### Patch Changes

- 2d6675d: Fix edge cases in chunking and embedding: apply a default max chunk size (20,000 chars) when none is configured, recursively split oversized chunks at finer heading levels (h2→h3→…→h6) before falling back to AST node boundary splitting, and truncate oversized embedding inputs to stay within the OpenAI token limit.
- df2c538: Rename manifest file from `.docs-mcp.json` to avoid clashes in schemastore
