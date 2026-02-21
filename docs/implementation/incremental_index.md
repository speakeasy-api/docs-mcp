# Incremental Indexing

## Purpose

The `docs-mcp build` pipeline supports incremental indexing — re-embedding only new or changed chunks while preserving correct, deterministic output. For large production corpora (thousands of files), this avoids expensive full embedding API passes on every build.

## Design Constraints

1. **Determinism preserved.** Given the same input corpus, a build with a warm cache produces identical `chunks.json` and equivalent search results from `.lancedb/` compared to a cold build. Equivalence is defined as: for any fixed query and filter, both indexes return the same `chunk_id` set in the same rank order.
2. **No server changes.** The incremental strategy is entirely build-side. `metadata.json`, `chunks.json`, and the `.lancedb/` directory retain their schemas. The server, eval harness, and MCP tools are unaffected.
3. **Embedding provider agnostic.** The caching layer sits below the `EmbeddingProvider` interface. It works identically for any provider — though the cost savings are only material for API-based providers.
4. **On by default.** Embedding caching is enabled by default. A `--rebuild-cache` flag forces all chunks to be re-embedded and writes a fresh cache. The cache is self-healing — incompatible or corrupt caches are discarded with a warning, never silently.
5. **CI-cache friendly.** The cache is a single directory that can be archived/restored by standard CI cache actions.

## Change Detection: Content Hashing

A chunk's embedding depends on exactly two inputs: the embedding model configuration and the text sent to the provider. If both are unchanged, the vector is unchanged.

### Single Source of Truth for Embedding Input

Both the embedding call and the fingerprint computation use the same function to construct the text payload:

```typescript
// Defined once in @speakeasy-api/docs-mcp-core/embedding.ts
function toEmbeddingInput(chunk: Chunk): string {
  return `Context: ${chunk.breadcrumb}\n\nContent:\n${chunk.content_text}`;
}
```

The breadcrumb includes the heading text, so heading changes are captured. Both `provider.embed()` and `computeFingerprint()` call `toEmbeddingInput()` — there is no second code path that could diverge.

### Embedding Fingerprint

```typescript
const EMBEDDING_FORMAT_VERSION = "1";

type EmbeddingFingerprint = string; // SHA-256 hex digest

function computeFingerprint(chunk: Chunk, config: EmbeddingConfig): EmbeddingFingerprint {
  const input = [
    EMBEDDING_FORMAT_VERSION,
    config.configFingerprint,
    toEmbeddingInput(chunk),
  ].join("\0");
  return sha256hex(input);
}
```

The **null-byte delimiter** prevents ambiguous concatenations.

### Provider Config Fingerprint

Each `EmbeddingProvider` implementation exposes a `configFingerprint` getter: a stable SHA-256 hash of all configuration fields that affect vector output.

```typescript
interface EmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
  configFingerprint: string;
}
```

**What goes into `configFingerprint` per provider:**

| Provider | Fields hashed |
|---|---|
| `hash` | `provider`, `model`, `dimensions` |
| `openai` | `provider`, `model`, `dimensions`, `baseUrl` |

### Why `chunk_id` Is Not Sufficient

Chunk IDs are structure-derived (`{filepath}#{heading-path}`), not content-derived. Editing a paragraph under an `## Authentication` heading does not change the chunk ID. The fingerprint must hash the actual text sent to the embedding model.

## Embedding Cache

### Storage Format

The cache uses a **LanceDB table** stored in a dedicated directory (`.embedding-cache/`). Since `@lancedb/lancedb` is already a project dependency, this adds zero new dependencies while providing binary Arrow storage for vectors, O(1) point lookups by fingerprint, and natural compatibility with directory-based CI caches.

**Schema:**

| Column | Type | Description |
|---|---|---|
| `fingerprint` | `string` | SHA-256 hex digest (primary key for lookups) |
| `chunk_id` | `string` | Stored for diagnostics only |
| `vector` | `FixedSizeList<Float32>[dims]` | The embedding vector |

**Cache metadata** is stored in a sibling file `.embedding-cache/cache-meta.json`:

```json
{
  "cache_version": "1",
  "format_version": "1",
  "config_fingerprint": "a3f8..."
}
```

- **`cache_version`**: For forward compatibility. Cache is discarded (with warning) on major version mismatch.
- **`format_version`**: Must match `EMBEDDING_FORMAT_VERSION`. If the embedding input construction changes and this constant is bumped, the cache is invalidated.
- **`config_fingerprint`**: Must match the current provider's `configFingerprint`. If any differ, the entire cache is invalidated.

### File Location

- Default: `{out}/.embedding-cache/` (sibling to `.lancedb/` and `metadata.json`)
- Overridable via `--cache-dir <path>` for CI environments that persist caches separately.

### Cache Lifecycle

1. **Cleanup**: Remove any leftover `.embedding-cache.tmp/` and `.embedding-cache.old/` directories from a previous interrupted build.
2. **Load**: Read `cache-meta.json`. If missing, corrupt, or incompatible, discard the entire cache directory, emit a warning to stderr with the reason, and proceed with a cold build. Cache read is skipped when `--rebuild-cache` is set.
3. **Match**: For each chunk, compute its fingerprint. Batch-query the cache table for all fingerprints. Partition chunks into cache-hit (vector reused) and cache-miss (needs embedding) sets.
4. **Embed**: Send only the cache-miss chunks to the `EmbeddingProvider`.
5. **Merge**: Combine cached vectors + freshly embedded vectors.
6. **Prune & Write Cache**: Write the cache table with only the current build's fingerprint→vector mappings using the rotate-and-rename pattern (see "Atomic Writes" below). This keeps cache size proportional to corpus size.
7. **Write Index**: Overwrite the LanceDB index table (rebuilt from the full chunk set). Write `chunks.json` and `metadata.json`.

### Atomic Writes

Cache writes use a **rotate-and-rename** pattern:

1. Write new cache table and `cache-meta.json` to `.embedding-cache.tmp/`.
2. `rename(.embedding-cache, .embedding-cache.old)` — best-effort.
3. `rename(.embedding-cache.tmp, .embedding-cache)` — atomic swap-in.
4. `rm -rf .embedding-cache.old` — async/best-effort cleanup.

On POSIX, directory rename is atomic. `.embedding-cache/` always contains a valid state — it transitions directly from old to new with no gap.

### Why the LanceDB Index Table Is Still Overwritten

LanceDB's FTS indexes and scalar indexes must reflect the current corpus exactly. Stale rows from deleted files must be removed. The cheapest correct strategy is to rebuild the table from the full set of chunks+vectors each time. The expensive operation being skipped is the embedding API calls, not the local index write.

## CLI Interface

```
# Default: incremental (reads/writes embedding cache automatically)
docs-mcp build \
  --docs-dir ./docs \
  --out ./index \
  --embedding-provider openai

# Re-embed everything and write a fresh cache
docs-mcp build \
  --docs-dir ./docs \
  --out ./index \
  --embedding-provider openai \
  --rebuild-cache

# Explicit cache location (useful for CI with persistent caches)
docs-mcp build \
  --docs-dir ./docs \
  --out ./index \
  --embedding-provider openai \
  --cache-dir /tmp/docs-mcp-cache
```

### Build Output

The build command emits cache metrics to stderr:

```
embedding cache: 1847 hits, 53 misses (97.2% hit rate)
embedded 53 chunks via openai in 2.1s
wrote 1900 chunks and .lancedb index to ./index
```

On cache invalidation:

```
warn: embedding cache invalidated: config_fingerprint mismatch (provider config changed)
embedded 1900 chunks via openai in 34.7s
wrote 1900 chunks and .lancedb index to ./index
```

## Cost Model

For a corpus of N total chunks where M chunks changed since last build:

| Operation | Full Build | Incremental Build |
|---|---|---|
| Chunking (AST parse) | N | N |
| Fingerprint computation | 0 | N (SHA-256, ~μs each) |
| Embedding API calls | N | M |
| LanceDB index table write | N | N |
| Cache read (binary) | 0 | O(N) Arrow scan |
| Cache write (binary) | 0 | O(N) Arrow write |

The savings are entirely in embedding API calls: `(N - M) × cost_per_embedding`.

## Edge Cases

- **First build**: No cache exists. All chunks are embedded. Cache is written for next run.
- **Embedding provider changed**: `config_fingerprint` mismatch → warning emitted → entire cache invalidated → full embed.
- **Model dimensions changed**: Same as above (dimensions are part of `configFingerprint`).
- **Base URL changed**: Same as above (`baseUrl` is part of `configFingerprint`).
- **Embedding input template changed**: `format_version` mismatch → warning emitted → entire cache invalidated.
- **Cache directory corrupt/unreadable**: Warning emitted, proceed with full embed, write fresh cache.
- **`cache-meta.json` missing but LanceDB files present**: Treated as corrupt — warning, discard, cold build.
- **Interrupted write**: May leave `.embedding-cache.tmp/` or `.embedding-cache.old/`. Next build's startup cleanup removes both and proceeds.
