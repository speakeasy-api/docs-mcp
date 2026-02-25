# @speakeasy-api/docs-mcp-core

## 0.2.0

### Minor Changes

- 9998fcd: Add `taxonomy` manifest field with `vector_collapse` option for collapsing content-equivalent search results across variant axes (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity are collapsed to the highest-scoring variant. On a realistic 30MB multi-language corpus this improved facet precision by 27%, MRR@5 by 10%, and NDCG@5 by 15%.

### Patch Changes

- 2d6675d: Fix edge cases in chunking and embedding: apply a default max chunk size (20,000 chars) when none is configured, recursively split oversized chunks at finer heading levels (h2→h3→…→h6) before falling back to AST node boundary splitting, and truncate oversized embedding inputs to stay within the OpenAI token limit.
- df2c538: Rename manifest file from `.docs-mcp.json` to avoid clashes in schemastore
