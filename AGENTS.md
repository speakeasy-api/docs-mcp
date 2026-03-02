# Agent Guidelines for docs-mcp

## What This Project Is

docs-mcp is a domain-agnostic search engine for SDK documentation, served over the Model Context Protocol (MCP). The pipeline is: markdown docs + `.docs-mcp.json` manifests → `docs-mcp build` (AST chunking + embedding) → `.lancedb` index → `docs-mcp-server` exposes `search_docs` and `get_doc` tools to coding agents.

The monorepo has four published packages: `core` (indexing/search primitives), `server` (MCP runtime), `cli` (build/validate/fix toolchain), and `eval` (benchmarks + agent evals). Plus a `playground` for interactive demos.

## Key Concepts

### Manifests (`.docs-mcp.json`)

Distributed throughout the docs directory tree. Control chunking strategy (`chunk_by: h2`, `file`, etc.), metadata taxonomy (`language`, `scope`), and glob-based overrides. Nearest-ancestor wins — no cross-directory inheritance. YAML frontmatter in individual files overrides manifest settings. See [docs/implementation/manifest_contract.md](docs/implementation/manifest_contract.md).

### Indexing Pipeline

`docs-mcp build` parses markdown ASTs via `remark`, chunks by heading boundaries, generates embeddings (pluggable: `none`/`hash`/`openai`), and writes `.lancedb/` + `metadata.json` + `chunks.json`. Incremental builds via embedding cache (`.embedding-cache/`) — only changed chunks re-embedded. See [docs/implementation/incremental_index.md](docs/implementation/incremental_index.md).

### MCP Tools

The server exposes two tools with dynamic JSON Schema:

- **`search_docs`** — hybrid search (FTS + vector via Reciprocal Rank Fusion). Taxonomy filters injected as `enum` arrays from `metadata.json`. Stateless cursor pagination. Zero-result fallback hints.
- **`get_doc`** — fetch chunk by ID with optional adjacent context. Chunk IDs follow `{filepath}#{heading-path}` format.

See [docs/implementation/mcp_tool_contracts.md](docs/implementation/mcp_tool_contracts.md).

### Chunk Identity Scheme

Deterministic, human-readable: `{relative_filepath}#{heading-path}`. Preamble chunks use `#_preamble`. Duplicate headings get `-2`, `-3` suffixes. IDs are stable unless headings are renamed/reordered.

## Build & Test

```bash
pnpm build       # Turbo build (all packages)
pnpm test        # Vitest (all packages)
pnpm typecheck   # TypeScript (all packages)
pnpm lint        # ESLint (all packages)
```

Single package: `pnpm -F @speakeasy-api/docs-mcp-core test`

Node >=22 required. `pnpm@10.5.2`.

## Coding Conventions

- **`exactOptionalPropertyTypes`** is enabled — use conditional spreads for optional props, not direct assignment.
- Packages use ES modules (`"type": "module"`).

## Agent Eval Setup

The eval framework (`packages/eval`) provides two modes:

### Search Quality Eval

Validates retrieval ranking without agents. Drives the MCP server via stdio and measures MRR@5, NDCG@5, facet precision, latency, and memory.

```bash
docs-mcp-eval run \
  --cases ./eval-cases.json \
  --server-command "node packages/server/dist/bin.js --index-dir ./my-index"
```

Full reference: [docs/eval.md](docs/eval.md)

### Agent Eval

End-to-end: spawns an AI agent with docs-mcp tools, runs against a prompt, checks assertions on output.

```bash
# Built-in suite with local fixture docs
docs-mcp-eval agent-eval --suite acmeauth --provider anthropic

# External SDK docs (cloned via docsSpec in scenario)
docs-mcp-eval agent-eval --suite dub-ts --provider anthropic --model claude-sonnet-4-20250514

# Filter scenarios, run concurrently
docs-mcp-eval agent-eval --suite dub-ts --include create-link --max-concurrency 3
```

Built-in suites: `acmeauth`, `dub-go`, `dub-python`, `dub-ts`, `mistral-python`, `mistral-ts`, `pushpress-ts`

#### Providers

| Provider | Flag | Backend | Auth |
|----------|------|---------|------|
| Anthropic | `--provider anthropic` | `@anthropic-ai/claude-agent-sdk` | `ANTHROPIC_API_KEY` |
| OpenAI Codex | `--provider openai` | `codex exec --json` (CLI spawn) | `OPENAI_API_KEY` + `codex` on PATH |
| Auto | `--provider auto` | Detected from env | Whichever key is set |

#### Writing Scenarios

Scenarios are JSON files keyed by scenario ID. Each specifies a prompt, docs source (`docsDir` for local, `docsSpec` for git clone), and assertions (`contains`, `not_contains`, `matches`, `file_contains`, `file_matches`, `script`). The CLI auto-builds indexes and caches them.

#### Results

Auto-saved to `.eval-results/<suite>/` with trend comparison against prior runs. Use `--out` for explicit output, `--debug` to preserve workspaces.

Full reference: [docs/agent-eval.md](docs/agent-eval.md)

## Key Implementation Notes

- **Codex provider**: MCP config passed via `-c` flags. Hyphens in server names replaced with underscores for TOML key compat.
- **Index caching**: Eval caches indexes at `.cache/indexes/` (content hash key), repos at `.cache/repos/` (url+ref key).
- **Embedding cache**: Build pipeline caches embeddings at `.embedding-cache/` — invalidated on provider/model change.
- **Dynamic schema**: Server reads `metadata.json` at boot; taxonomy keys become `enum` properties on `search_docs`. Domain-agnostic — no hardcoded field names.
- **Auto-include rule**: When `language` is provided but `scope` is not, SDK-specific results are automatically expanded to include global guides.

## Documentation Index

- [docs/architecture.md](docs/architecture.md) — package structure, design decisions
- [docs/eval.md](docs/eval.md) — search quality eval (metrics, cases, benchmarks)
- [docs/agent-eval.md](docs/agent-eval.md) — agent eval (scenarios, assertions, providers, CI)
- [docs/implementation/manifest_contract.md](docs/implementation/manifest_contract.md) — `.docs-mcp.json` schema and resolution
- [docs/implementation/metadata_contract.md](docs/implementation/metadata_contract.md) — `metadata.json` build artifact
- [docs/implementation/mcp_tool_contracts.md](docs/implementation/mcp_tool_contracts.md) — `search_docs` and `get_doc` contracts
- [docs/implementation/incremental_index.md](docs/implementation/incremental_index.md) — embedding cache and incremental builds
