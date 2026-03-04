---
"@speakeasy-api/docs-mcp-eval": patch
---

Fix CLI resolution when installed from npm

Resolve the CLI entry point via `import.meta.resolve` instead of a hardcoded relative path (`../cli/dist/index.js`) that only works inside the monorepo. Adds `@speakeasy-api/docs-mcp-cli` as a dependency so the module resolver can find it in both monorepo and published contexts.
