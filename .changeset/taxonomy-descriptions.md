---
"@speakeasy-api/docs-mcp-core": minor
"@speakeasy-api/docs-mcp-cli": minor
---

Add a `description` property for taxonomy dimensions in `.docs-mcp.json`. The build writes it to `metadata.json`, and the server uses it as the description of that dimension's `search_docs` filter parameter in place of the default `Filter results by {key}.`, so a corpus can tell agents what a dimension and its values mean. Manifests that set different descriptions for the same dimension are rejected.
