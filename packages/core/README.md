# @speakeasy-api/docs-mcp-core

Core retrieval and indexing primitives for [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp): markdown chunking, hybrid search, and LanceDB integration.

**Beta.** Part of the [`docs-mcp`](https://github.com/speakeasy-api/docs-mcp) monorepo.

## What This Package Does

- AST-based markdown parsing and intelligent chunking (respects heading boundaries and code blocks)
- Hybrid search combining full-text search with semantic vector search via Reciprocal Rank Fusion
- LanceDB integration with memory-mapped IO for fast retrieval
- Embedding generation and caching (OpenAI or deterministic hash)
- Manifest resolution and metadata extraction from `.docs-mcp.json` files

## Installation

```bash
npm install @speakeasy-api/docs-mcp-core
```

## Usage

This package is primarily consumed by [`@speakeasy-api/docs-mcp-server`](https://www.npmjs.com/package/@speakeasy-api/docs-mcp-server) and [`@speakeasy-api/docs-mcp-cli`](https://www.npmjs.com/package/@speakeasy-api/docs-mcp-cli). See the [monorepo README](https://github.com/speakeasy-api/docs-mcp) for end-to-end usage.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
