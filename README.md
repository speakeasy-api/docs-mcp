<div align="center">
  <a href="https://www.speakeasy.com/" target="_blank">
    <img
      width="1500"
      height="500"
      alt="Speakeasy"
      src="https://github.com/user-attachments/assets/0e56055b-02a3-4476-9130-4be299e5a39c"
    />
  </a>
</div>

# Speakeasy Docs MCP

A lightweight, domain-agnostic hybrid search engine for markdown (`.md`) corpora, exposed via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). While it can index and serve **any** markdown corpus, it is deeply optimized for serving SDK documentation to AI coding agents. **Beta.**

## Features

- **Hybrid search** — full-text, phrase proximity, and vector similarity blended via Reciprocal Rank Fusion
- **Distributed manifests** — per-directory `.docs-mcp.json` files configure chunking strategy, metadata, and taxonomy independently per subtree
- **Faceted taxonomy** — metadata keys become enum-injected JSON Schema filters on the search tool
- **Vector collapse** — deduplicates near-identical cross-language results at search time
- **Incremental builds** — embedding cache fingerprints each chunk; only changed content is re-embedded
- **Graceful degradation**
  - _Chunking_ — chunk sizes adapt to the configured embedding provider's context window; falls back to conservative defaults when no provider is set
  - _Query_ — if the embedding API errors at runtime (downtime, expired credits, network issues), the server falls back to FTS-only search with a one-time warning

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

On a realistic ~300-operation API with hand-written guides (~28.8MB corpus, 5 eval categories), benchmarked with [`docs-mcp-eval benchmark`](docs/eval.md):

### Summary

| Metric                     |    none |    openai | Takeaway                                       |
| -------------------------- | ------: | --------: | ---------------------------------------------- |
| MRR@5                      |  0.2141 |    0.2833 | Embeddings lift relevant-result ranking by 32% |
| NDCG@5                     |  0.2536 |    0.3218 | Graded relevance improves 27% with embeddings  |
| Facet Precision            |  0.3750 |    0.4375 | Embeddings improve filter accuracy by 17%      |
| Search p50 (ms)            |     5.2 |     258.4 | FTS-only is ~50x faster at median              |
| Search p95 (ms)            |     6.5 |   11101.1 | Tail latency dominated by embedding API        |
| Build Time (ms)            |    6022 |   1569703 | Embedding uses batch API for large corpora     |
| Peak RSS (MB)              |   221.1 |     283.8 | Modest memory overhead                         |
| Index Size (corpus 28.8MB) | 104.9MB |   356.9MB | Vectors ~3.4x the FTS-only index               |
| Embed Cost (est.)          |      $0 |   $0.9825 | ~$1 one-time cost per corpus                   |
| Query Cost (est.)          |      $0 | $0.000003 | Negligible per-query cost                      |

### Per-Category MRR@5

> MRR@5 (Mean Reciprocal Rank at 5) measures how high the first relevant result appears in the top 5. 1.0 = always ranked first; 0.0 = never appears in top 5.

| Category         |   none | openai | Takeaway                      |
| ---------------- | -----: | -----: | ----------------------------- |
| clarification    | 0.3000 | 0.3000 | FTS matches embeddings        |
| cross-service    | 0.1667 | 0.3333 | Embeddings double rank        |
| exact-name       | 0.3625 | 0.3792 | FTS nearly matches embeddings |
| natural-language | 0.0731 | 0.1692 | Embeddings lift 130%          |
| workflow         | 0.3333 | 0.4444 | Embeddings lift 33%           |

### Recommendation

We recommend starting with FTS-only search. While embeddings improve relevance for conceptual and paraphrased queries, they also introduce ~50x query latency and substantial build overhead. For agents that iterate through multiple searches, the faster cycle time of pure FTS has anecdotally proven more valuable than the per-query relevance lift — particularly with modern models capable of query refinement.

## Graceful Fallback

1. **No embeddings** (`--embedding-provider none`): FTS-only search, zero cost, zero API keys. Already effective for exact-match and lexical queries.
2. **With embeddings** (`--embedding-provider openai`): Hybrid search with better recall on conceptual and paraphrased queries. ~$1 one-time embedding cost per 28.8MB corpus.
3. **Runtime degradation**: If the embedding API is unavailable at query time, the server automatically falls back to FTS-only with a one-time warning.

## Supported File Types

The indexer processes **`.md` (Markdown)** files. Files are discovered via the `**/*.md` glob pattern within the configured docs directory. YAML frontmatter is supported for per-file metadata and chunking overrides.

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
    "chunk_by": "h2", // Split at ## headings. Options: h1, h2, h3, file
    "max_chunk_size": 8000, // Oversized chunks split recursively at finer headings
    "min_chunk_size": 200, // Tiny trailing chunks merge into preceding chunk
  },

  // Key-value pairs attached to every chunk. Each key becomes a filterable
  // enum parameter on the search_docs tool.
  "metadata": {
    "language": "typescript",
    "scope": "sdk-specific",
  },

  // Per-field search behavior. vector_collapse deduplicates cross-language
  // variants at search time (only active when no filter is set for that field).
  "taxonomy": {
    "language": { "vector_collapse": true },
  },

  // Custom instructions sent to MCP clients during initialization.
  // Helps coding agents understand what this server provides and how to use it.
  "mcpServerInstructions": "This server provides SDK documentation for Acme Corp...",

  // File-pattern overrides. Evaluated top-to-bottom; last match wins.
  // Override metadata merges with root (override keys win).
  // Override strategy replaces root strategy entirely.
  "overrides": [
    {
      "pattern": "models/**/*.md",
      "strategy": { "chunk_by": "file" },
    },
  ],
}
```

Full schema: [`schemas/docs-mcp.schema.json`](schemas/docs-mcp.schema.json)

Individual files can also override their manifest via YAML frontmatter (`mcp_chunking_hint`, `metadata` keys). Frontmatter takes highest precedence. See the [manifest contract](docs/implementation/manifest_contract.md) for full resolution rules.

## Architecture

Structured as a Turborepo with four packages:

| Package                          | Role                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `@speakeasy-api/docs-mcp-cli`    | CLI for validation, manifest bootstrap (`fix`), and deterministic indexing (`build`)      |
| `@speakeasy-api/docs-mcp-core`   | Core retrieval primitives, AST parsing, chunking, and LanceDB queries                     |
| `@speakeasy-api/docs-mcp-server` | Lean runtime MCP server surface                                                           |
| `@speakeasy-api/docs-mcp-eval`   | Standalone evaluation harness — search-quality benchmarks and end-to-end agent evaluation |

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

| Tool          | What it does                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Performs hybrid search. Tool names and descriptions are user-configurable. Parameters are dynamically generated with valid taxonomy injected as JSON Schema `enum`s. Supports stateless cursor pagination. Returns fallback hints on zero results. |
| `get_doc`     | Returns a specific chunk, plus `context: N` neighboring chunks for surrounding detail.                                                                                                                                                             |

## Quick Start

### FTS-Only (Recommended)

No API keys required. Zero-config full-text search:

```dockerfile
# --- build stage ---
FROM node:22-slim AS build
RUN npm install -g @speakeasy-api/docs-mcp-cli
ARG DOCS_DIR=docs
COPY ${DOCS_DIR} /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider none

# --- runtime stage ---
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-server
COPY --from=build /index /index
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

```bash
docker build --build-arg DOCS_DIR=./docs -t docs-mcp .
docker run -p 20310:20310 docs-mcp
```

### With Embeddings (Optional)

For hybrid FTS + semantic search, add an OpenAI embedding provider. This improves recall on conceptual and paraphrased queries at the cost of higher latency and ~$1 one-time embedding cost per 28.8MB corpus.

```dockerfile
# --- build stage ---
FROM node:22-slim AS build
RUN npm install -g @speakeasy-api/docs-mcp-cli
ARG DOCS_DIR=docs
COPY ${DOCS_DIR} /corpus
RUN --mount=type=secret,id=OPENAI_API_KEY \
    OPENAI_API_KEY=$(cat /run/secrets/OPENAI_API_KEY) \
    docs-mcp build --docs-dir /corpus --out /index --embedding-provider openai

# --- runtime stage ---
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-server
COPY --from=build /index /index
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

```bash
docker build --secret id=OPENAI_API_KEY,env=OPENAI_API_KEY \
  --build-arg DOCS_DIR=./docs -t docs-mcp .
docker run -p 20310:20310 -e OPENAI_API_KEY docs-mcp
```

The build secret embeds the corpus; the runtime `-e OPENAI_API_KEY` lets the server embed search queries.

### Docker Compose (Server + Playground)

To get a server and interactive playground running together:

```yaml
# docker-compose.yml
services:
  server:
    build:
      context: .
      # Uses the Dockerfile above (FTS-only or embeddings variant)
    ports:
      - "20310:20310"
    # Uncomment for embeddings:
    # environment:
    #   - OPENAI_API_KEY=${OPENAI_API_KEY}

  playground:
    image: node:22-slim
    command: >
      sh -c "npm install -g @speakeasy-api/docs-mcp-playground &&
             npx @speakeasy-api/docs-mcp-playground"
    ports:
      - "3001:3001"
    environment:
      - MCP_TARGET=http://server:20310
    depends_on:
      - server
```

```bash
docker compose up
```

Open `http://localhost:3001` to explore the index interactively.

## Transport Options

The MCP server supports two transport modes:

| Flag                | Transport       | Default       | Use case                                                    |
| ------------------- | --------------- | ------------- | ----------------------------------------------------------- |
| `--transport stdio` | Standard I/O    | Yes (default) | Direct MCP client integration (e.g. Claude Desktop, Cursor) |
| `--transport http`  | Streamable HTTP |               | Containerized deployments, playground, multi-client access  |

When using HTTP transport, the server listens on port `20310` by default (configurable with `--port`).

**stdio example** (MCP client config):

```bash
npx @speakeasy-api/docs-mcp-server --index-dir ./dist/.lancedb
```

**HTTP example**:

```bash
npx @speakeasy-api/docs-mcp-server --index-dir ./dist/.lancedb --transport http --port 20310
```

## Usage & Deployment

**1. Authoring (Local Dev)**

The `fix` command scans all `.md` files in your docs directory, analyzes their heading structure (h1/h2/h3 frequency), and generates a `.docs-mcp.json` manifest with the best-fit chunking strategy per file. The most common strategy becomes the default; files that differ get pattern-based overrides.

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

**4. Playground (Optional)**

Explore the index interactively in a browser. The playground connects to a running HTTP server and provides a search UI.

```bash
npx @speakeasy-api/docs-mcp-playground
```

Open `http://localhost:3001`. Requires a running HTTP server (step 3 with `--transport http`).

| Environment Variable  | Description                                         | Default                  |
| --------------------- | --------------------------------------------------- | ------------------------ |
| `MCP_TARGET`          | HTTP endpoint of the MCP server                     | `http://localhost:20310` |
| `PORT`                | Playground server port                              | `3001`                   |
| `SERVER_NAME`         | Display name shown in the playground UI             | `speakeasy-docs`         |
| `PLAYGROUND_PASSWORD` | Password-protect the playground (hashed via SHA256) | _(none — open access)_   |
| `GRAM_API_KEY`        | Enables chat mode when set                          | _(none — chat disabled)_ |

## Evaluation

Docs MCP includes a standalone evaluation harness with two modes:

- **Search-quality eval** (`run`) — drives the MCP server directly via stdio JSON-RPC, measuring retrieval metrics (MRR, NDCG, precision, latency). See [docs/eval.md](docs/eval.md).
- **Agent eval** (`agent-eval`) — spawns a Claude agent with docs-mcp tools, runs it against a prompt, and evaluates assertions on the output. Validates the full stack end-to-end. See [docs/agent-eval.md](docs/agent-eval.md).

## License

[AGPL-3.0](LICENSE)
