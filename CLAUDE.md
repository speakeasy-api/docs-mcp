# docs-mcp

Lightweight, domain-agnostic embedded search engine exposed via MCP, optimized for serving SDK documentation to AI coding agents. Takes a directory of markdown files, builds a hybrid search index (FTS + vector), and serves it over the Model Context Protocol so coding agents can discover and retrieve documentation in-context.

## Project Structure

Turborepo monorepo (`pnpm@10.5.2`, Node >=22):

| Package | Published As | Description |
|---------|-------------|-------------|
| `packages/core` | `@speakeasy-api/docs-mcp-core` | Retrieval and indexing primitives — AST-based markdown chunking, hybrid search (BM25 FTS + vector via Reciprocal Rank Fusion), LanceDB integration, embedding generation |
| `packages/server` | `@speakeasy-api/docs-mcp-server` | MCP server runtime — exposes `search_docs` and `get_doc` tools over stdio and HTTP transports. Dynamic JSON Schema enum injection from indexed taxonomy |
| `packages/cli` | `@speakeasy-api/docs-mcp-cli` | CLI toolchain — `docs-mcp build` (deterministic indexer), `docs-mcp fix` (LLM-assisted manifest bootstrapping), `docs-mcp validate` (structural checks) |
| `packages/eval` | `@speakeasy-api/docs-mcp-eval` | Evaluation framework — search quality benchmarks (MRR@5, NDCG@5, latency, memory) and end-to-end agent evals |
| `packages/playground` | `@speakeasy-api/docs-mcp-playground` | Interactive web playground (React + Express) for demonstrating and exploring a docs-mcp server |
| `packages/eslint-config` | — | Shared ESLint config |
| `packages/tsconfig` | — | Shared TypeScript config |

## Build & Test

```bash
pnpm build       # Turbo build across all packages
pnpm test        # Vitest across all packages
pnpm lint        # ESLint across packages
pnpm typecheck   # TypeScript across packages
```

Single package:

```bash
pnpm -F @speakeasy-api/docs-mcp-core test
pnpm -F @speakeasy-api/docs-mcp-eval build
```

Releases use changesets: `pnpm changeset` to propose, `pnpm release` to build and publish.

## Coding Conventions

- **`exactOptionalPropertyTypes`** is enabled — use conditional spreads (`...(val !== undefined && { key: val })`) for optional props, not direct assignment.
- License: AGPL-3.0-only.

## How It Works

### 1. Authoring: `.docs-mcp.json` manifests

Documentation corpora are configured via `.docs-mcp.json` manifests distributed throughout the directory tree. Each manifest defines chunking strategy (`chunk_by: h1|h2|h3|file`), metadata (taxonomy facets like `language`, `scope`), and glob-based overrides. YAML frontmatter in individual files can override manifest settings. Nearest-ancestor manifest wins (no cross-directory inheritance). See [docs/implementation/manifest_contract.md](docs/implementation/manifest_contract.md).

### 2. Indexing: `docs-mcp build`

The CLI parses markdown into ASTs via `remark`, chunks by heading boundaries, generates embeddings (pluggable: `none` for FTS-only, `hash` for testing, `openai` for production), and writes a `.lancedb` directory + `metadata.json` + `chunks.json`. Embedding caching (`.embedding-cache/`) enables incremental builds — only changed chunks are re-embedded. See [docs/implementation/incremental_index.md](docs/implementation/incremental_index.md).

```bash
docs-mcp build --docs-dir ./docs --out ./index --embedding-provider openai
```

### 3. Serving: `docs-mcp-server`

The MCP server boots from a built index directory and exposes two tools:

- **`search_docs`** — hybrid search with dynamic taxonomy filters injected as JSON Schema enums. Stateless cursor pagination. Zero-result fallback hints guide agents toward valid queries.
- **`get_doc`** — fetch a specific chunk by ID with optional adjacent context expansion.

The server reads `metadata.json` at boot to construct dynamic tool schemas. See [docs/implementation/mcp_tool_contracts.md](docs/implementation/mcp_tool_contracts.md) and [docs/implementation/metadata_contract.md](docs/implementation/metadata_contract.md).

```bash
docs-mcp-server --index-dir ./index                     # stdio transport
docs-mcp-server --index-dir ./index --transport http     # HTTP transport
```

### 4. Evaluation: `docs-mcp-eval`

Two evaluation modes:

- **Search quality eval** (`docs-mcp-eval run`) — validates retrieval ranking (MRR@5, NDCG@5, facet precision, latency, memory) without agents. Drives the MCP server via stdio and measures metrics against predefined query suites. See [docs/eval.md](docs/eval.md).
- **Agent eval** (`docs-mcp-eval agent-eval`) — end-to-end: spawns an AI agent (Claude or OpenAI Codex) with docs-mcp tools, runs it against a prompt, and checks assertions on output. Auto-builds indexes, caches repos, tracks trends. See [docs/agent-eval.md](docs/agent-eval.md).

```bash
# Search quality
docs-mcp-eval run --cases ./eval-cases.json --server-command "node packages/server/dist/bin.js --index-dir ./my-index"

# Agent eval
docs-mcp-eval agent-eval --suite acmeauth --provider claude
docs-mcp-eval agent-eval --suite dub-ts --include create-link,list-links --max-concurrency 3
```

Built-in agent eval suites: `acmeauth`, `dub-go`, `dub-python`, `dub-ts`, `mistral-python`, `mistral-ts`, `pushpress-ts`

Results auto-save to `.eval-results/<suite>/` with trend comparison against prior runs.

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | eval (Claude provider) | Required for `--provider claude` or `--provider auto` |
| `OPENAI_API_KEY` | eval (Codex provider), CLI (OpenAI embeddings) | Required for `--provider openai` or `--embedding-provider openai` |
| `NO_COLOR` | eval | Disables ANSI color output |

## Documentation

- [docs/architecture.md](docs/architecture.md) — architectural design decisions, package structure rationale
- [docs/eval.md](docs/eval.md) — search quality evaluation framework (metrics, cases, benchmarks)
- [docs/agent-eval.md](docs/agent-eval.md) — agent evaluation framework (scenarios, assertions, providers, CI)
- [docs/implementation/manifest_contract.md](docs/implementation/manifest_contract.md) — `.docs-mcp.json` schema, resolution rules, precedence
- [docs/implementation/metadata_contract.md](docs/implementation/metadata_contract.md) — `metadata.json` build artifact schema
- [docs/implementation/mcp_tool_contracts.md](docs/implementation/mcp_tool_contracts.md) — `search_docs` and `get_doc` JSON Schema contracts
- [docs/implementation/incremental_index.md](docs/implementation/incremental_index.md) — embedding cache and incremental build design
