---
"@speakeasy-api/docs-mcp-server": minor
---

Simplify the server package programmatic API around `createDocsServer()`.

- remove the old `createDocsMcpServerFactory()` and `createDocsServerFactory()` exports
- make `DocsServer` the public callable server type instead of exporting a separate `DocsServerFactory` alias
- let `createDocsServer()` and `startHttpServer()` share the same default name, version, build metadata, and logging behavior as the CLI
- accept plain `console`-shaped loggers when a custom logger is provided, while keeping the default internal logger setup automatic
