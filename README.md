<div align="center">
 <a href="https://www.speakeasy.com/" target="_blank">
  <img width="1500" height="500" alt="Speakeasy" src="https://github.com/user-attachments/assets/0e56055b-02a3-4476-9130-4be299e5a39c" />
 </a>
 <br />
 <br />
<div>
<a href="https://go.speakeasy.com/slack" target="_blank"><b>Join us on Slack</b></a>
</div>
</div>

<br />

# Docs MCP Server Generator

A lightweight, domain-agnostic embedded search engine exposed via the Model
Context Protocol (MCP).

## Features

-	**Hybrid search.** Combines full-text search, phrase matching,
  and vector similarity to deliver highly relevant results.
-	**Markdown-aware chunking.** Splits documents intelligently by headings or file,
  never breaking code blocks or losing structure.
-	**Fully local operation.** No external API calls at runtime. Everything is indexed
  at build time and queried locally for fast, offline searches.
-	**Context-aware schemas.** Automatically adapts search tools and filters to your
  data’s taxonomy, exposing valid filter values in the schema.
-	**Self-correcting zero-result handling.** When a search returns nothing, it
  suggests alternative filters to guide agents toward better queries.
-	**Contextual document retrieval.** Fetches a document chunk along with its
  surrounding context, ensuring searches return coherent sections.
-	**Flexible embedding options.** Supports multiple embedding backends: OpenAI,
  deterministic local hashing, or purely text-based mode.
-	**Configurable with manifests.** Uses a layered configuration system with
  file-based overrides, frontmatter hints, and inline directives.
-	**Reproducible builds.** Embedding results are cached, so only changed documents
  are reprocessed for consistent, incremental builds.
-	**Works anywhere.** Runs over stdio or HTTP (JSON-RPC 2.0), compatible with any
  MCP host environment.

## Usage

### In Speakeasy SDKs

Speakeasy-generated SDKs are already optimized for MCP Docs. Each SDK package
includes a `.mcp-manifest.json` with intelligent chunking hints based on the
document structure. The indexer uses these hints to create perfectly sized
chunks that preserve code blocks and context.

To get started, run the following from the root of your Speakeasy SDK:

```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

### In Other Projects

If you have a corpus of unchunked markdown files, you can use the CLI to
automatically generate a manifest with intelligent chunking hints based on the
document structure. This will create a `.mcp-manifest.json` in each folder,
which the indexer will use to chunk the documents at build time.

```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

### Local Testing

...


👇👇👇 original content 👇👇👇


MCP Docs separates the heavy LLM/authoring workflows from the deterministic CI
build and the lean runtime server.

**1. Authoring (Local Dev)**

If you have legacy docs without chunking strategies, use the CLI locally to
bootstrap a baseline `.mcp-manifest.json`.

```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**

Run the deterministic indexer against your corpus. The indexer reads manifests
and frontmatter to chunk the docs, generates embeddings, and saves the local
`.lancedb` directory. _This step makes no LLM calls._

```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (Static MCP)**
The `.lancedb` directory is packaged with the MCP server. At runtime, the server operates entirely locally with zero external API calls for search.

```typescript
import { McpDocsServer } from "@speakeasy-api/docs-mcp-server";

// The server reads corpus_description, taxonomy, and embedding config
// from the metadata.json generated alongside the .lancedb index at build time.
const server = new McpDocsServer({
  dbPath: "./dist/.lancedb",
});

server.start();
```


## Quick Start

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
COPY docs /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider hash
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

## The Problem

Enterprise coding agents need documentation to write correct code, but standard RAG (Retrieval-Augmented Generation) architectures fail in two major ways:

1. **Generic Corpus Failures:** Standard vector search doesn't understand the shape of your data. If you have multiple products or versions, the agent gets confused without explicit filtering, and hardcoding those filters ruins the reusability of the search engine.
2. **The "SDK Monolith" Problem:** Speakeasy generates comprehensive, highly structured documentation (often producing 13,000+ line READMEs for large services). Standard 1,000-character chunking destroys code blocks, and returning the whole file blows out an LLM's context window.

## The Solution

MCP Docs provides a local, in-memory Hybrid Search engine (powered by LanceDB) that runs directly inside your Node.js/TypeScript MCP server. LanceDB's memory-mapped architecture ensures lightning-fast retrieval even on large datasets. It solves the RAG problems through a flexible, agent-optimized architecture.

### Generic Capabilities (For Any Markdown Corpus)

- **Dynamic Tool Schemas & Enum Injection:** The engine is entirely domain-agnostic. It reads a `metadata.json` generated during indexing and dynamically constructs the MCP tools. It strictly enforces taxonomy by injecting valid values (e.g., `['typescript', 'python']`) directly into the JSON Schema as `enum`s. This guarantees the LLM provides valid filters upfront, eliminating hallucinated searches and wasted round-trips.
- **Agent Prompting via `corpus_description`:** The user configures a `corpus_description` (e.g., "Internal HR Policies" or "Acme Corp SDKs"). The MCP server uses this to dynamically write the tool descriptions, effectively giving the LLM a custom system prompt on exactly _how_ and _when_ to search.
- **Hybrid Search (RRF Baseline):** Combines exact-match Full-Text Search (critical for specific error codes or class names) with Semantic Vector Search (critical for conceptual queries). Ranking beyond the v1 baseline is eval-driven.
- **Stateless Pagination & Fallbacks:** Uses opaque cursor tokens to paginate results without server-side memory leaks. If a search yields zero results due to strict filtering, it returns structured hints (e.g., "0 results in 'typescript'. Matches found in: ['python'].") to guide the agent.

### Speakeasy-Optimized Capabilities (For SDK Documentation)

When used with Speakeasy SDKs, the engine leverages distributed manifests to enable powerful features:

- **Intelligent Chunking Hints:** Instead of naive character limits, the indexer uses a "hinting" system (`h1`, `h2`, `h3`, `file`) to find perfect boundaries. These hints are distributed: they can be defined in a `.docs-mcp.json` within an imported SDK folder, or overridden by YAML frontmatter for specific guides.
- **Hierarchical Context Injection:** Ancestor headings (`Service: Auth > Method: Login`) are injected into the text sent to the embedding model, ensuring the vector perfectly captures the intent of the isolated code block.
- **Strict Resolution (Enforced Taxonomy):** Speakeasy generates docs for Python, TS, Go, etc., creating massive semantic duplication. Instead of trying to dynamically "collapse" results, the server relies on the dynamically injected JSON Schema `enum`s to force the LLM to define the language upfront based on the user's workspace.

## Architecture

MCP Docs is structured as a Turborepo to strictly decouple authoring, indexing, runtime retrieval, and evaluation:

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

| Tool          | What it does                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Performs hybrid search. Tool names and descriptions are user-configurable. Parameters are dynamically generated with valid taxonomy injected as JSON Schema `enum`s. Supports stateless cursor pagination. Returns fallback hints on zero results. |
| `get_doc`     | Returns a specific chunk, plus `context: N` neighboring chunks. This allows the agent to read surrounding implementation details without fetching massive monolithic files.                                                                        |

## Delivery Gate

Before expanding scope, v1 starts with a minimal vertical slice: deterministic indexing plus `search_docs`/`get_doc` on fixture data, followed by a side-by-side eval report against the Rust/Tantivy POC.

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

MCP Docs separates the heavy LLM/authoring workflows from the deterministic CI build and the lean runtime server.

**1. Authoring (Local Dev)**
If you have legacy docs without chunking strategies, use the CLI locally to bootstrap a baseline `.docs-mcp.json`.
```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**
Run the deterministic indexer against your corpus. The indexer reads manifests and frontmatter to chunk the docs, generates embeddings, and saves the local `.lancedb` directory. _This step makes no LLM calls._

```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (Static MCP)**
The `.lancedb` directory is packaged with the MCP server. At runtime, the server operates entirely locally with zero external API calls for search.

```typescript
import { McpDocsServer } from "@speakeasy-api/docs-mcp-server";

// The server reads corpus_description, taxonomy, and embedding config
// from the metadata.json generated alongside the .lancedb index at build time.
const server = new McpDocsServer({
  dbPath: "./dist/.lancedb",
});

server.start();
```

## License

Apache 2.0

<div align="center">
 <a href="https://www.speakeasy.com/" target="_blank">
  <img width="1500" height="500" alt="Speakeasy" src="https://github.com/user-attachments/assets/0e56055b-02a3-4476-9130-4be299e5a39c" />
 </a>
 <br />
 <br />
<div>
<a href="https://go.speakeasy.com/slack" target="_blank"><b>Join us on Slack</b></a>
</div>
</div>

<br />

# Docs MCP Server Generator

A lightweight, domain-agnostic embedded search engine exposed via the Model
Context Protocol (MCP).

## Features

-	**Hybrid search.** Combines full-text search, phrase matching,
  and vector similarity to deliver highly relevant results.
-	**Markdown-aware chunking.** Splits documents intelligently by headings or file,
  never breaking code blocks or losing structure.
-	**Fully local operation.** No external API calls at runtime. Everything is indexed
  at build time and queried locally for fast, offline searches.
-	**Context-aware schemas.** Automatically adapts search tools and filters to your
  data’s taxonomy, exposing valid filter values in the schema.
-	**Self-correcting zero-result handling.** When a search returns nothing, it
  suggests alternative filters to guide agents toward better queries.
-	**Contextual document retrieval.** Fetches a document chunk along with its
  surrounding context, ensuring searches return coherent sections.
-	**Flexible embedding options.** Supports multiple embedding backends: OpenAI,
  deterministic local hashing, or purely text-based mode.
-	**Configurable with manifests.** Uses a layered configuration system with
  file-based overrides, frontmatter hints, and inline directives.
-	**Reproducible builds.** Embedding results are cached, so only changed documents
  are reprocessed for consistent, incremental builds.
-	**Works anywhere.** Runs over stdio or HTTP (JSON-RPC 2.0), compatible with any
  MCP host environment.

## Usage

### Local Development

...

### Deployment

...

MCP Docs separates the heavy LLM/authoring workflows from the deterministic CI
build and the lean runtime server.

**1. Authoring (Local Dev)**

If you have legacy docs without chunking strategies, use the CLI locally to
bootstrap a baseline `.mcp-manifest.json`.

```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**

Run the deterministic indexer against your corpus. The indexer reads manifests
and frontmatter to chunk the docs, generates embeddings, and saves the local
`.lancedb` directory. _This step makes no LLM calls._

```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (Static MCP)**
The `.lancedb` directory is packaged with the MCP server. At runtime, the server operates entirely locally with zero external API calls for search.

```typescript
import { McpDocsServer } from "@speakeasy-api/docs-mcp-server";

// The server reads corpus_description, taxonomy, and embedding config
// from the metadata.json generated alongside the .lancedb index at build time.
const server = new McpDocsServer({
  dbPath: "./dist/.lancedb",
});

server.start();
```


## Quick Start

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
COPY docs /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider hash
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

## The Problem

Enterprise coding agents need documentation to write correct code, but standard RAG (Retrieval-Augmented Generation) architectures fail in two major ways:

1. **Generic Corpus Failures:** Standard vector search doesn't understand the shape of your data. If you have multiple products or versions, the agent gets confused without explicit filtering, and hardcoding those filters ruins the reusability of the search engine.
2. **The "SDK Monolith" Problem:** Speakeasy generates comprehensive, highly structured documentation (often producing 13,000+ line READMEs for large services). Standard 1,000-character chunking destroys code blocks, and returning the whole file blows out an LLM's context window.

## The Solution

MCP Docs provides a local, in-memory Hybrid Search engine (powered by LanceDB) that runs directly inside your Node.js/TypeScript MCP server. LanceDB's memory-mapped architecture ensures lightning-fast retrieval even on large datasets. It solves the RAG problems through a flexible, agent-optimized architecture.

### Generic Capabilities (For Any Markdown Corpus)

- **Dynamic Tool Schemas & Enum Injection:** The engine is entirely domain-agnostic. It reads a `metadata.json` generated during indexing and dynamically constructs the MCP tools. It strictly enforces taxonomy by injecting valid values (e.g., `['typescript', 'python']`) directly into the JSON Schema as `enum`s. This guarantees the LLM provides valid filters upfront, eliminating hallucinated searches and wasted round-trips.
- **Agent Prompting via `corpus_description`:** The user configures a `corpus_description` (e.g., "Internal HR Policies" or "Acme Corp SDKs"). The MCP server uses this to dynamically write the tool descriptions, effectively giving the LLM a custom system prompt on exactly _how_ and _when_ to search.
- **Hybrid Search (RRF Baseline):** Combines exact-match Full-Text Search (critical for specific error codes or class names) with Semantic Vector Search (critical for conceptual queries). Ranking beyond the v1 baseline is eval-driven.
- **Stateless Pagination & Fallbacks:** Uses opaque cursor tokens to paginate results without server-side memory leaks. If a search yields zero results due to strict filtering, it returns structured hints (e.g., "0 results in 'typescript'. Matches found in: ['python'].") to guide the agent.

### Speakeasy-Optimized Capabilities (For SDK Documentation)

When used with Speakeasy SDKs, the engine leverages distributed manifests to enable powerful features:

- **Intelligent Chunking Hints:** Instead of naive character limits, the indexer uses a "hinting" system (`h1`, `h2`, `h3`, `file`) to find perfect boundaries. These hints are distributed: they can be defined in a `.mcp-manifest.json` within an imported SDK folder, or overridden by YAML frontmatter for specific guides.
- **Hierarchical Context Injection:** Ancestor headings (`Service: Auth > Method: Login`) are injected into the text sent to the embedding model, ensuring the vector perfectly captures the intent of the isolated code block.
- **Strict Resolution (Enforced Taxonomy):** Speakeasy generates docs for Python, TS, Go, etc., creating massive semantic duplication. Instead of trying to dynamically "collapse" results, the server relies on the dynamically injected JSON Schema `enum`s to force the LLM to define the language upfront based on the user's workspace.

## Architecture

MCP Docs is structured as a Turborepo to strictly decouple authoring, indexing, runtime retrieval, and evaluation:

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

| Tool          | What it does                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_docs` | Performs hybrid search. Tool names and descriptions are user-configurable. Parameters are dynamically generated with valid taxonomy injected as JSON Schema `enum`s. Supports stateless cursor pagination. Returns fallback hints on zero results. |
| `get_doc`     | Returns a specific chunk, plus `context: N` neighboring chunks. This allows the agent to read surrounding implementation details without fetching massive monolithic files.                                                                        |

## Delivery Gate

Before expanding scope, v1 starts with a minimal vertical slice: deterministic indexing plus `search_docs`/`get_doc` on fixture data, followed by a side-by-side eval report against the Rust/Tantivy POC.

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

MCP Docs separates the heavy LLM/authoring workflows from the deterministic CI build and the lean runtime server.

**1. Authoring (Local Dev)**
If you have legacy docs without chunking strategies, use the CLI locally to bootstrap a baseline `.mcp-manifest.json`.

```bash
npx @speakeasy-api/docs-mcp-cli fix --docs-dir ./docs
```

**2. Indexing (CI Build Step)**
Run the deterministic indexer against your corpus. The indexer reads manifests and frontmatter to chunk the docs, generates embeddings, and saves the local `.lancedb` directory. _This step makes no LLM calls._

```bash
npx @speakeasy-api/docs-mcp-cli build --docs-dir ./docs --out ./dist/.lancedb
```

**3. Runtime (Static MCP)**
The `.lancedb` directory is packaged with the MCP server. At runtime, the server operates entirely locally with zero external API calls for search.

```typescript
import { McpDocsServer } from "@speakeasy-api/docs-mcp-server";

// The server reads corpus_description, taxonomy, and embedding config
// from the metadata.json generated alongside the .lancedb index at build time.
const server = new McpDocsServer({
  dbPath: "./dist/.lancedb",
});

server.start();
```

## License

Apache 2.0
