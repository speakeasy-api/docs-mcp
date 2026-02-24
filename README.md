# Speakeasy Docs MCP

A lightweight, domain-agnostic embedded search engine exposed via the Model Context Protocol (MCP). **Beta.**

While it can index and serve **any** markdown corpus, it is deeply optimized to solve the unique challenges of serving [Speakeasy](https://www.speakeasy.com)-generated SDK documentation to AI coding agents.

## The Problem

Enterprise coding agents need documentation to write correct code, but standard RAG (Retrieval-Augmented Generation) architectures fail in two major ways:
1. **Generic Corpus Failures:** Standard vector search doesn't understand the shape of your data. If you have multiple products or versions, the agent gets confused without explicit filtering, and hardcoding those filters ruins the reusability of the search engine.
2. **The "SDK Monolith" Problem:** Speakeasy generates comprehensive, highly structured documentation (often producing 13,000+ line READMEs for large services). Standard 1,000-character chunking destroys code blocks, and returning the whole file blows out an LLM's context window.

## The Solution

Docs MCP provides a local, in-memory Hybrid Search engine (powered by LanceDB) that runs directly inside your Node.js/TypeScript MCP server. LanceDB's memory-mapped architecture ensures lightning-fast retrieval even on large datasets. It solves the RAG problems through a flexible, agent-optimized architecture.

### Generic Capabilities (For Any Markdown Corpus)

- **Dynamic Tool Schemas & Enum Injection:** The engine is entirely domain-agnostic. It reads a `metadata.json` generated during indexing and dynamically constructs the MCP tools. It strictly enforces taxonomy by injecting valid values (e.g., `['typescript', 'python']`) directly into the JSON Schema as `enum`s. This guarantees the LLM provides valid filters upfront, eliminating hallucinated searches and wasted round-trips.
- **Agent Prompting via `corpus_description`:** The user configures a `corpus_description` (e.g., "Internal HR Policies" or "Acme Corp SDKs"). The MCP server uses this to dynamically write the tool descriptions, effectively giving the LLM a custom system prompt on exactly *how* and *when* to search.
- **Hybrid Search (RRF Baseline):** Combines exact-match Full-Text Search (critical for specific error codes or class names) with Semantic Vector Search (critical for conceptual queries). Ranking beyond the v1 baseline is eval-driven.
- **Stateless Pagination & Fallbacks:** Uses opaque cursor tokens to paginate results without server-side memory leaks. If a search yields zero results due to strict filtering, it returns structured hints (e.g., "0 results in 'typescript'. Matches found in: ['python'].") to guide the agent.

### Speakeasy-Optimized Capabilities (For SDK Documentation)

When used with Speakeasy SDKs, the engine leverages distributed manifests to enable powerful features:

- **Intelligent Chunking Hints:** Instead of naive character limits, the indexer uses a "hinting" system (`h1`, `h2`, `h3`, `file`) to find perfect boundaries. These hints are distributed: they can be defined in a `.docs-mcp.json` within an imported SDK folder, or overridden by YAML frontmatter for specific guides.
- **Hierarchical Context Injection:** Ancestor headings (`Service: Auth > Method: Login`) are injected into the text sent to the embedding model, ensuring the vector perfectly captures the intent of the isolated code block.
- **Strict Resolution (Enforced Taxonomy):** Speakeasy generates docs for Python, TS, Go, etc., creating massive semantic duplication. Instead of trying to dynamically "collapse" results, the server relies on the dynamically injected JSON Schema `enum`s to force the LLM to define the language upfront based on the user's workspace.

## Architecture

Docs MCP is structured as a Turborepo to strictly decouple authoring, indexing, runtime retrieval, and evaluation:

1. **`@speakeasy-api/docs-mcp-cli`**: The CLI toolchain for validation, manifest bootstrap (`docs-mcp fix`), and deterministic indexing (`docs-mcp build`).
2. **`@speakeasy-api/docs-mcp-core`**: Core retrieval primitives, AST parsing, and LanceDB queries.
3. **`@speakeasy-api/docs-mcp-server`**: The lean runtime Model Context Protocol surface.
4. **`@speakeasy-api/docs-mcp-eval`**: Standalone evaluation and benchmarking harness.

Source materialization (Git sync, sparse checkout, include/exclude policy) is host-owned by Static MCP and feeds a deterministic local docs directory into `docs-mcp`.

```text
                +---------------------------+
                |     Agent / MCP Host      |
                +-------------+-------------+
                              |
                              | Dynamic Tool Schema (with Enums)
                              v
                +---------------------------+
                | Speakeasy Static MCP      |
                | (TypeScript/Node)         |
                +-------------+-------------+
                              |
                              v
                +---------------------------+
                | @speakeasy-api/docs-mcp-server|
                | search_docs, get_doc      |
                +-------------+-------------+
                              |
                              v
                +---------------------------+
                | @speakeasy-api/docs-mcp-core  |
                | LanceDB Engine            |
                | Memory-Mapped IO          |
                +-------------+-------------+
                              |
                              v
                     +-----------------+
                     | .lancedb/ index |
                     | (baked in image)|
                     +--------+--------+
```

## MCP Tools

The tools exposed to the agent are dynamically generated based on your `corpus_description` and indexed metadata.

| Tool | What it does |
|---|---|
| `search_docs` | Performs hybrid search. Tool names and descriptions are user-configurable. Parameters are dynamically generated with valid taxonomy injected as JSON Schema `enum`s. Supports stateless cursor pagination. Returns fallback hints on zero results. |
| `get_doc` | Returns a specific chunk, plus `context: N` neighboring chunks. This allows the agent to read surrounding implementation details without fetching massive monolithic files. |

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

Docs MCP separates the heavy LLM/authoring workflows from the deterministic CI build and the lean runtime server.

**1. Authoring (Local Dev)**
If you have legacy docs without chunking strategies, use the CLI locally to bootstrap a baseline `.docs-mcp.json`.
```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**
Run the deterministic indexer against your corpus. The indexer reads manifests and frontmatter to chunk the docs, generates embeddings, and saves the local `.lancedb` directory. *This step makes no LLM calls.*
```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (Static MCP)**
The `.lancedb` directory is packaged with the MCP server. At runtime, the server operates entirely locally with zero external API calls for search.
```typescript
import { McpDocsServer } from '@speakeasy-api/docs-mcp-server';

// The server reads corpus_description, taxonomy, and embedding config
// from the metadata.json generated alongside the .lancedb index at build time.
const server = new McpDocsServer({
  dbPath: './dist/.lancedb',
});

server.start();
```

## License

[AGPL-3.0](LICENSE)
