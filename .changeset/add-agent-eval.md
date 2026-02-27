---
"@speakeasy-api/docs-mcp-eval": minor
"@speakeasy-api/docs-mcp-server": patch
"@speakeasy-api/docs-mcp-core": patch
---

Add agent evaluation harness for end-to-end testing of MCP tool usage

Introduces a self-contained agent eval framework that uses Claude Agent SDK to run realistic coding scenarios against docs-mcp, with assertion-based scoring, file content validation, and an interactive CLI (`docs-mcp-eval`). Includes multi-language scenarios for several SDKs, build caching, history tracking, and configurable tool descriptions in the server.
