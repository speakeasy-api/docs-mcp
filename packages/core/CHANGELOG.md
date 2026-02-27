# @speakeasy-api/docs-mcp-core

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
