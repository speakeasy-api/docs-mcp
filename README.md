# Speakeasy Docs MCP

A lightweight, domain-agnostic hybrid search engine for markdown corpora, exposed via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). While it can index and serve **any** markdown corpus, it is deeply optimized for serving SDK documentation to AI coding agents. **Beta.**

## How It Works

Docs MCP provides a local, in-memory search engine (powered by [LanceDB](https://lancedb.github.io/lancedb/)) that runs inside a Node.js MCP server. Three core optimizations make it effective for structured documentation:

### Faceted Taxonomy

Metadata keys defined in [`.docs-mcp.json`](#corpus-structure) manifests become enum-injected JSON Schema parameters on the `search_docs` tool. The agent selects from a strict set of valid filter values (e.g. `language: ["typescript", "python", "go"]`). On zero results, the server returns structured hints (e.g. "0 results for 'typescript'. Matches found in: ['python']").

### Vector Collapse

SDK documentation for the same API operation across multiple languages produces near-identical embeddings. Vector collapse deduplicates these at search time, keeping only the highest-scoring variant per taxonomy field:

```json
{ "taxonomy": { "language": { "vector_collapse": true } } }
```

When the agent explicitly filters by language, collapse is automatically skipped — the filter already restricts to a single variant.

### Hybrid FTS + Semantic Search

Search combines three ranking signals via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

1. **Full-text search** — multi-field matching on headings (boosted 3x) and content
2. **Phrase proximity** — rewards results where query terms appear close together
3. **Vector similarity** — semantic embedding distance (when an embedding provider is configured)

FTS dominates for exact class names and error codes. Vector similarity lifts conceptual and paraphrased queries. The blend is configurable via RRF weights.

### Hierarchical Context

Ancestor headings (breadcrumbs like `Auth SDK > AcmeAuthClientV2 > Initialization`) are prepended to each chunk's embedding input and returned with search results. This enables the calling agent to explore the corpus structure, navigating from high-level concepts down to specific implementation details.

## Benchmarks

On a realistic 28.8MB multi-language SDK corpus (38 eval cases across 9 categories), benchmarked with [`docs-mcp-eval benchmark`](docs/eval.md):

### Summary

| Metric | none | openai/text-embedding-3-large |
| --- | ---: | ---: |
| MRR@5 | 0.1803 | 0.2320 |
| NDCG@5 | 0.2136 | 0.2657 |
| Facet Precision | 0.3158 | 0.3684 |
| Search p50 (ms) | 5.2 | 242.6 |
| Search p95 (ms) | 6.6 | 5914.1 |
| Build Time (ms) | 6989 | 20448 |
| Peak RSS (MB) | 247.6 | 313.6 |
| Index Size (corpus 28.8MB) | 104.9MB | 356.9MB |
| Embed Cost (est.) | $0 | $0.9825 |
| Query Cost (est.) | $0 | $0.000003 |

### Per-Category Facet Precision

| Category | none | openai/text-embedding-3-large |
| --- | ---: | ---: |
| api-discovery | 0.0000 | 0.0000 |
| cross-service | 0.3333 | 0.3333 |
| distractor | 0.4000 | 0.4000 |
| error-handling | 0.0000 | 0.0000 |
| intent | 0.4000 | 0.4000 |
| lexical | 0.8000 | 0.8000 |
| multi-hop | 0.3333 | 0.3333 |
| paraphrased | 0.1250 | 0.2500 |
| sdk-reference | 0.3333 | 0.6667 |

### Per-Category MRR@5

| Category | none | openai/text-embedding-3-large |
| --- | ---: | ---: |
| api-discovery | 0.0000 | 0.0000 |
| cross-service | 0.1667 | 0.3333 |
| distractor | 0.3000 | 0.3000 |
| error-handling | 0.0000 | 0.0000 |
| intent | 0.0900 | 0.2667 |
| lexical | 0.4800 | 0.5067 |
| multi-hop | 0.3333 | 0.3333 |
| paraphrased | 0.0625 | 0.0938 |
| sdk-reference | 0.1667 | 0.2333 |

**Key takeaways:**
- Embeddings double facet precision on `paraphrased` and `sdk-reference` categories
- Embeddings triple MRR on `intent` queries (0.09 → 0.27)
- `lexical`, `distractor`, `cross-service`, `multi-hop` — FTS alone matches embedding performance
- FTS-only search: 5ms p50 latency, zero embedding cost

## Graceful Fallback

1. **No embeddings** (`--embedding-provider none`): FTS-only search, zero cost, zero API keys. Already effective for exact-match and lexical queries.
2. **With embeddings** (`--embedding-provider openai`): Hybrid search with better recall on conceptual and paraphrased queries. ~$1 one-time embedding cost per 28.8MB corpus.
3. **Runtime degradation**: If the embedding API is unavailable at query time, the server automatically falls back to FTS-only with a one-time warning.

## Corpus Structure

### Folder Layout

Documentation corpora use `.docs-mcp.json` manifests to control chunking and taxonomy. Manifests can be placed at any level of the directory tree:

```
my-docs/
├── .docs-mcp.json              ← root manifest (applies to guides/)
├── guides/
│   ├── retries.md
│   └── pagination.md
└── sdks/
    ├── typescript/
    │   ├── .docs-mcp.json      ← deeper manifest (exclusive precedence)
    │   └── auth.md
    └── python/
        ├── .docs-mcp.json      ← deeper manifest (exclusive precedence)
        └── auth.md
```

**Deeper manifests take exclusive precedence.** A file at `sdks/typescript/auth.md` is governed only by `sdks/typescript/.docs-mcp.json` — the root manifest is ignored for that subtree.

### `.docs-mcp.json`

```jsonc
{
  // Required. Schema version.
  "version": "1",

  // Chunking strategy applied to all files in this directory tree.
  "strategy": {
    "chunk_by": "h2",         // Split at ## headings. Options: h1, h2, h3, file
    "max_chunk_size": 8000,   // Oversized chunks split recursively at finer headings
    "min_chunk_size": 200     // Tiny trailing chunks merge into preceding chunk
  },

  // Key-value pairs attached to every chunk. Each key becomes a filterable
  // enum parameter on the search_docs tool.
  "metadata": {
    "language": "typescript",
    "scope": "sdk-specific"
  },

  // Per-field search behavior. vector_collapse deduplicates cross-language
  // variants at search time (only active when no filter is set for that field).
  "taxonomy": {
    "language": { "vector_collapse": true }
  },

  // File-pattern overrides. Evaluated top-to-bottom; last match wins.
  // Override metadata merges with root (override keys win).
  // Override strategy replaces root strategy entirely.
  "overrides": [
    {
      "pattern": "models/**/*.md",
      "strategy": { "chunk_by": "file" }
    }
  ]
}
```

Full schema: [`schemas/docs-mcp.schema.json`](schemas/docs-mcp.schema.json)

Individual files can also override their manifest via YAML frontmatter (`mcp_chunking_hint`, `metadata` keys). Frontmatter takes highest precedence. See the [manifest contract](docs/implementation/manifest_contract.md) for full resolution rules.

## Architecture

Structured as a Turborepo with four packages:

| Package | Role |
|---|---|
| `@speakeasy-api/docs-mcp-cli` | CLI for validation, manifest bootstrap (`fix`), and deterministic indexing (`build`) |
| `@speakeasy-api/docs-mcp-core` | Core retrieval primitives, AST parsing, chunking, and LanceDB queries |
| `@speakeasy-api/docs-mcp-server` | Lean runtime MCP server surface |
| `@speakeasy-api/docs-mcp-eval` | Standalone evaluation and benchmarking harness |

```text
                +---------------------------+
                |     Agent / MCP Host      |
                +-------------+-------------+
                              |
                              | Dynamic Tool Schema (with Enums)
                              v
                +---------------------------+
                | @speakeasy-api/           |
                |   docs-mcp-server         |
                | search_docs, get_doc      |
                +-------------+-------------+
                              |
                              v
                +---------------------------+
                | @speakeasy-api/           |
                |   docs-mcp-core           |
                | LanceDB Engine            |
                | Memory-Mapped IO          |
                +-------------+-------------+
                              |
                              v
                     +-----------------+
                     | .lancedb/ index |
                     +-----------------+
```

## MCP Tools

The tools exposed to the agent are dynamically generated based on your `corpus_description` and indexed metadata.

| Tool | What it does |
|---|---|
| `search_docs` | Performs hybrid search. Tool names and descriptions are user-configurable. Parameters are dynamically generated with valid taxonomy injected as JSON Schema `enum`s. Supports stateless cursor pagination. Returns fallback hints on zero results. |
| `get_doc` | Returns a specific chunk, plus `context: N` neighboring chunks for surrounding detail. |

## Quick Start

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
COPY docs /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider hash
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

## Usage & Deployment

**1. Authoring (Local Dev)**
If you have legacy docs without chunking strategies, use the CLI locally to bootstrap a baseline `.docs-mcp.json`.
```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**
Run the deterministic indexer against your corpus. The indexer reads manifests and frontmatter to chunk the docs, generates embeddings, and saves the local `.lancedb` directory. Cache the output directory across CI runs to make builds incremental — only changed chunks are re-embedded.
```yaml
- uses: actions/cache@v4
  with:
    path: ./dist/.lancedb
    # Unique key saves the updated cache after each build
    key: docs-mcp-${{ github.run_id }}
    # Prefix match loads the most recent prior cache
    restore-keys: docs-mcp-

- run: npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (MCP Server)**
The `.lancedb` directory is packaged with the MCP server. FTS search is fully local. If the index was built with embeddings, the server calls the embedding API at query time to embed the search query.
```bash
npx @speakeasy-api/docs-mcp-server --index-dir ./dist/.lancedb
```

## Evaluation

Docs MCP includes a standalone evaluation harness for measuring search quality with transparent, repeatable benchmarks. See the [Evaluation Framework](docs/eval.md) for how to build an eval suite, run benchmarks across embedding providers, and interpret results.

## License

[AGPL-3.0](LICENSE)
