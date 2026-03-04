---
"@speakeasy-api/docs-mcp-server": minor
"@speakeasy-api/docs-mcp-core": minor
"@speakeasy-api/docs-mcp-cli": minor
---

Added MCP prompt template support to docs-mcp: docs authors can now define prompts with \*.template.md (simple single-message prompts) or \*.template.yaml (structured multi-message prompts), with mustache argument rendering at runtime. Prompt templates are excluded from search indexing, surfaced through MCP prompts/list and prompts/get, and when both formats exist for the same prompt name, YAML is preferred with a warning.
