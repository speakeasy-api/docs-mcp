---
"@speakeasy-api/docs-mcp-core": minor
"@speakeasy-api/docs-mcp-cli": minor
"@speakeasy-api/docs-mcp-server": minor
---

Add `taxonomy` manifest field with `vector_collapse` option for collapsing content-equivalent search results across variant axes (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity are collapsed to the highest-scoring variant. On a realistic 30MB multi-language corpus this improved facet precision by 27%, MRR@5 by 10%, and NDCG@5 by 15%.
