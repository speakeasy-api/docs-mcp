# Architecture: Docs MCP

This document details the architectural and design decisions for the TypeScript/LanceDB implementation of the `docs-mcp` retrieval engine. The project is structured as a Turborepo containing four distinct packages to enforce strict decoupling between authoring, indexing, runtime retrieval, and evaluation.

## 1. Turborepo Package Structure

The system is divided into four core packages:

1.  **`@speakeasy-api/docs-mcp-cli`**: The pipeline for validating, fixing, and building the index. Contains heavy LLM dependencies for authoring tools that never leak into the runtime.
2.  **`@speakeasy-api/docs-mcp-core`**: The retrieval and indexing primitives. Contains AST parsing, chunking logic, LanceDB schema definition, and hybrid search execution.
3.  **`@speakeasy-api/docs-mcp-server`**: The runtime Model Context Protocol surface. Exposes tools, injects dynamic JSON Schema enums, and handles client transport. Extremely lean.
4.  **`@speakeasy-api/docs-mcp-eval`**: The standalone benchmarking and quality assurance harness.

```text
┌────────────────────────────────────────────────────────┐
│  Speakeasy Static MCP (Host Application)               │
│  Owns source sync, orchestration, and feedback         │
├────────────────────────────────────────────────────────┤
│  @speakeasy-api/docs-mcp-server (Runtime)              │
│  search_docs, get_doc (Dynamic Schema & Enums)         │
├────────────────────────────────────────────────────────┤
│  @speakeasy-api/docs-mcp-core (Primitives)             │
│  AST Parsing, Chunking, LanceDB Hybrid Search          │
├────────────────────────────┬───────────────────────────┤
│  Validation & Build        │  Eval                     │
│  (-cli)                    │  (-eval)                  │
│  validate, fix, build      │  Benchmarks               │
└────────────────────────────┴───────────────────────────┘
```

## 2. Content Materialization Contract (Host-Owned)

Before content can be indexed, it must be fetched and organized by the host product. `docs-mcp` does not own VCS orchestration.

- **Source Resolution:** The host resolves configured sources (Git clone/sync, sparse checkout, includes/excludes) into a deterministic local staging directory.
- **Contract:** The input directory passed into `docs-mcp validate`/`docs-mcp build` contains only markdown and sidecar metadata intended for indexing, with stable paths for reproducible chunk identifiers.

## 3. Validation & Content Preparation (`@speakeasy-api/docs-mcp-cli`)

Speakeasy generates massive monolithic `README.md` files. Naive chunking destroys these files. The CLI package ensures content is perfectly chunked and metadata is accurate _before_ indexing.

### The Validation and Fix Pipeline

To keep the CI build fast and deterministic, authoring logic is separated from indexing.

1.  **`docs-mcp validate` (Fast CI Gatekeeper):** Parses the AST to verify structural integrity. It catches dangling chunking hints, orphaned HTML metadata comments, and enforces JSON schema taxonomy on frontmatter. To prevent brittleness from external SDK syncs, it emits non-fatal warnings for files missing explicit strategies, falling back to a global catch-all rule (e.g., `**/*.md -> h2`).
2.  **`docs-mcp fix` (LLM-Assisted Authoring):** A local tool for authors. It can bootstrap a new directory by scanning content to generate a `.docs-mcp.json`, or repair drift if a document outgrows its current chunking strategy. It proposes fixes and persists them locally.
3.  **`docs-mcp build` (Deterministic Indexer):** Strictly fails if structural validation fails. Builds the `.lancedb` directory. Embedding generation is controlled by a pluggable embedding backend (see §3a below).

### 3a. Embedding Backend (`EmbeddingProvider` Interface)

The embedding model is fully configurable via a provider interface. The `docs-mcp build` command accepts an `--embedding-provider` flag (or config key) to select the backend.

**Supported backends:**

| Backend  | Use Case                                                           | Parallelism Strategy                             |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `none`   | FTS-only index, no embedding API calls                             | N/A                                              |
| `hash`   | Deterministic hash-based vectors for testing                       | N/A                                              |
| `openai` | Higher quality embeddings via `text-embedding-3-large` (3072-dim). | Concurrent HTTP batches with rate-limit backoff. |

**Implementation note:** The `EmbeddingProvider` interface is defined in `@speakeasy-api/docs-mcp-core`. The CLI passes the configured provider into the build pipeline to generate embeddings for the corpus. At runtime, the server uses the provider to embed search queries for vector search. If vector search is disabled or the index was built with `--embedding-provider none`, the server falls back to pure FTS and bypasses the embedding API.

### Intelligent Chunking & AST Parsing

The indexer (`@speakeasy-api/docs-mcp-core`, driven by the CLI) uses a strict AST parser (`remark`):

- **Chunking Hints:** Distributed via `.docs-mcp.json`, YAML frontmatter, or inline HTML comments.
- **Atomic Grouping:** When splitting at an `h2`, it collects all sibling nodes (paragraphs, code blocks, tables) to guarantee methods stay intact.
- **Hierarchical Context Injection:** Ancestor headings are prepended to the text sent to the embedding model to preserve semantic meaning (e.g., "Document: Setup > Retries. Content: ..."). This prefix is applied only to the embedding input — the FTS-indexed text and the stored display text remain unprefixed. BM25 field weighting (heading boost) ensures correct ranking without polluting the FTS column.

### Chunk Identity Scheme

Every chunk receives a deterministic, human-readable `chunk_id` derived from its source file path and heading structure. This ID is the primary key for `get_doc` retrieval and appears in `search_docs` results.

**Format:** `{relative_filepath}#{heading_path}`

**Rules:**

| Chunk Type                         | Format                                  | Example                                            |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Whole-file (no split)              | `{filepath}`                            | `models/user.md`                                   |
| Preamble (before first heading)    | `{filepath}#_preamble`                  | `guides/retries.md#_preamble`                      |
| Top-level heading                  | `{filepath}#{slug}`                     | `guides/retries.md#backoff-strategy`               |
| Nested heading                     | `{filepath}#{parent-slug}/{child-slug}` | `sdks/typescript/auth.md#authentication/get-token` |
| Duplicate heading (Nth occurrence) | `{filepath}#{slug}-{N}`                 | `guides/retries.md#examples-2`                     |

**Slugification algorithm:**

1. Convert to lowercase.
2. Strip all characters except `[a-z0-9 -]`.
3. Replace spaces with hyphens.
4. Collapse consecutive hyphens.

**Collision resolution:** Slugs are scoped to their parent heading. The first occurrence of a duplicate gets the clean slug; subsequent occurrences within the same parent are suffixed with `-2`, `-3`, etc., in document order. The `_preamble` prefix is reserved and cannot collide with a user heading (headings produce slugs via the algorithm above, which strips leading underscores since they're not in `[a-z0-9 -]`).

**Stability guarantee:** IDs are deterministic from file content, heading structure, and stable host-provided file paths. They change only when a heading is renamed, reordered, structurally moved, or source paths change.

## 4. Retrieval Path (`@speakeasy-api/docs-mcp-core` & `@speakeasy-api/docs-mcp-server`)

The corpus contains massive semantic duplication across languages (e.g., Python vs. TypeScript rate limiting).

### Dynamic Schema & JSON Schema `enum` Injection

To keep the engine agnostic, the server dynamically constructs tool schemas based on the indexed metadata.

- **Enum Injection:** Valid values for fields like `language` are injected directly into the JSON Schema as an `enum`. The LLM instantly knows the exact taxonomy.
- **Facet Pushdown (Pre-Filtering):** Dynamic arguments are mapped directly into LanceDB `WHERE` clauses, guaranteeing zero cross-language hallucinations.

### Strict Resolution (Avoiding Agent Round-Trips)

Attempting to dynamically "collapse" semantic duplicates is UX-hostile. The server relies entirely on the strongly-typed JSON Schema to force the LLM to define the language upfront, guaranteeing the correct snippet on the first round-trip.

### The "Auto-Include" Rule

To reduce agent round-trips, language-scoped SDK queries automatically include global guides.

Default expansion pattern:

```sql
(scope = 'sdk-specific' AND language = 'typescript') OR scope = 'global-guide'
```

Rule: apply this expansion when `language` is provided and `scope` is not explicitly provided by the caller. If `scope` is explicitly set, respect it exactly (no auto-expansion).

## 5. The MCP Tool Surface (`@speakeasy-api/docs-mcp-server`)

The server exposes tools optimized for agent workflows.

### `search_docs`

Purpose: Discovery via Hybrid Search (Vector + FTS).
Input:

```json
{
  "query": "how do retries work",
  "limit": 10,
  "language": "typescript",
  "cursor": "eyJvZmZzZXQiOjEwLCJsaW1pdCI6MTB9"
}
```

#### Pagination: Stateless Cursors

Pagination is strictly stateless. The server returns an opaque, base64-encoded `next_cursor` token in the response (encoding offset/limit or the last seen LanceDB row ID). The agent passes this token back as `cursor` in subsequent `search_docs` calls to retrieve the next page of results. The cursor includes a signature to prevent tampering.

#### Fallback Behavior: Guided Discovery

If a search yields 0 results, the tool returns a structured "hint" payload to guide the agent toward a successful query. For example, if an agent searches for a term but filters for a language where that operation isn't documented, the server returns available languages with matches as suggested filters.

### `get_doc`

Purpose: Context expansion without blowing out the LLM's context window.
Input:

```json
{
  "chunk_id": "guides/retries.md#backoff-strategy",
  "context": 1
}
```

The `chunk_id` follows the Chunk Identity Scheme defined in §3. Behavior: Returns the exact chunk, plus adjacent chunks within the same file based on the `context` parameter. Chunk sizing is trusted to be correct via the manifest-driven chunking pipeline — no runtime token cap is applied.
