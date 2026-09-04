---
"@speakeasy-api/docs-mcp-server": patch
---

Answer `prompts/list`, `resources/list` and `resources/templates/list` with an empty list when the corpus does not declare the corresponding capability, instead of `-32601` (Method not found). The capability stays undeclared. Some clients send these requests without checking the declared capabilities, and at least one widely deployed client reads the HTTP 404 that accompanies `-32601` as a lost session, failing every request after it.
