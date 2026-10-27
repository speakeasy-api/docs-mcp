---
"@speakeasy-api/docs-mcp-core": minor
"@speakeasy-api/docs-mcp-server": minor
"@speakeasy-api/docs-mcp-cli": minor
---

Add a `score_multiplier` property for taxonomy values in `.docs-mcp.json`. The server multiplies the search score of every chunk tagged with that value by it, so a corpus can rank superseded or secondary documentation below its replacement without removing it from the index. Multipliers from several taxonomy dimensions multiply together, apply before vector collapse and pagination, and are included in the returned scores. `LanceDbSearchEngine` and `InMemorySearchEngine` accept the multipliers through a `scoreMultipliers` option, and `getScoreMultipliers` reads them from index metadata.
