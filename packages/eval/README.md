# @speakeasy-api/docs-mcp-eval

Evaluation and benchmarking harness for [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp).

**Beta.** Part of the [`docs-mcp`](https://github.com/speakeasy-api/docs-mcp) monorepo.

## Installation

```bash
npm install -g @speakeasy-api/docs-mcp-eval
```

## Eval Types

### Search-Quality Eval (`run`)

Measures retrieval quality metrics (MRR, NDCG, precision, latency) by driving the MCP server directly via stdio JSON-RPC.

```bash
docs-mcp-eval run --cases ./cases.json \
  --server-command "docs-mcp-server --index-dir ./index"
```

- **Recall\@K** — fraction of expected chunks found in the top-K results
- **MRR** (Mean Reciprocal Rank) — how early the first relevant result appears
- **Precision\@K** — fraction of top-K results that are relevant
- **Delta reports** — side-by-side comparison between evaluation runs

See [docs/eval.md](https://github.com/speakeasy-api/docs-mcp/blob/main/docs/eval.md) for the full search-quality eval specification.

### Agent Eval (`agent-eval`)

End-to-end evaluation that spawns a Claude agent with docs-mcp tools, runs it against a prompt, and evaluates assertions on the output. Validates the full stack — from search quality to how well a real model uses the tools.

```bash
docs-mcp-eval agent-eval --scenarios ./my-scenarios.json --docs-dir ./my-docs
```

Supports `contains`, `not_contains`, `matches`, and `script` assertions, per-scenario docs sources (local path or git clone), auto-built index caching, and trend comparison against prior runs.

See [docs/agent-eval.md](https://github.com/speakeasy-api/docs-mcp/blob/main/docs/agent-eval.md) for the full agent eval specification.

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
