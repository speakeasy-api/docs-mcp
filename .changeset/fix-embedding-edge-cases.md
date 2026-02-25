---
"@speakeasy-api/docs-mcp-core": patch
---

Fix edge cases in chunking and embedding: apply a default max chunk size (20,000 chars) when none is configured, recursively split oversized chunks at finer heading levels (h2→h3→…→h6) before falling back to AST node boundary splitting, and truncate oversized embedding inputs to stay within the OpenAI token limit.
