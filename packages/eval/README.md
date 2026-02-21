# @speakeasy-api/docs-mcp-eval

Evaluation and benchmarking harness for [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp) search quality metrics.

**Beta.** Part of the [`docs-mcp`](https://github.com/speakeasy-api/docs-mcp) monorepo.

## Installation

```bash
npm install -g @speakeasy-api/docs-mcp-eval
```

## Usage

```bash
docs-mcp-eval --server-cmd "docs-mcp-server --index-dir ./index" --cases ./cases.json
```

## Metrics

- **Recall\@K** -- fraction of expected chunks found in the top-K results
- **MRR** (Mean Reciprocal Rank) -- how early the first relevant result appears
- **Precision\@K** -- fraction of top-K results that are relevant
- **Delta reports** -- side-by-side comparison between evaluation runs

See [docs/eval.md](https://github.com/speakeasy-api/docs-mcp/blob/main/docs/eval.md) for the full evaluation framework specification.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
