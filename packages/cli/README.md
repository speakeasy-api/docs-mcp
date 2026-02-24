# @speakeasy-api/docs-mcp-cli

CLI toolchain for validating, indexing, and bootstrapping [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp) documentation corpora.

**Beta.** Part of the [`docs-mcp`](https://github.com/speakeasy-api/docs-mcp) monorepo.

## Installation

```bash
npm install -g @speakeasy-api/docs-mcp-cli
```

## Commands

### `docs-mcp build`

Run the deterministic indexer against your corpus. Reads manifests and frontmatter to chunk docs, generates embeddings, and writes a `.lancedb` index.

```bash
docs-mcp build --docs-dir ./docs --out ./dist/.lancedb --embedding-provider hash
```

### `docs-mcp fix`

Bootstrap a baseline `.docs-mcp.json` for legacy docs without chunking strategies.

```bash
docs-mcp fix --docs-dir ./docs
```

## Usage in CI

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
COPY docs /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider hash
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
