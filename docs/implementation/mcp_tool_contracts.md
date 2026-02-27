# Contract: MCP Tools

## Purpose

This document defines the exact JSON Schema contracts and response structures for the MCP tools exposed by `@speakeasy-api/docs-mcp-server`. It maps the architectural requirements (dynamic taxonomy, cursor pagination, and fallback hints) into concrete interfaces that the agent host will consume.

### 1. Tool: `search_docs`

**Purpose:** Performs a hybrid search (Full-Text + Vector) across the documentation corpus. It enforces strict taxonomy upfront to prevent the LLM from hallucinating invalid filters.

**Tool Name:** `search_docs`
**Tool Description:** `Search the ${corpus_description}. Use this to find relevant documentation, guides, or API references.` _(Note: `${corpus_description}` is dynamically injected from `metadata.json` at boot)._

**Input Schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "query": {
      "type": "string",
      "description": "The search query (e.g., 'how to paginate', 'RateLimitError')."
    },
    "limit": {
      "type": "integer",
      "description": "Maximum number of results to return. Default is 10.",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    },
    "cursor": {
      "type": "string",
      "description": "Opaque pagination token returned from a previous search. Omit for the first page. Returns an error if invalid or malformed."
    },
    // --- DYNAMICALLY INJECTED TAXONOMY FIELDS ---
    // The server reads metadata.json taxonomy at boot and injects one optional
    // property per taxonomy key. Values are the exact canonical strings discovered
    // during indexing (casing preserved). No sentinel values (ANY/ALL) are injected
    // — omitting a taxonomy field means "no filter" for that facet.
    // Description text is sourced from taxonomy[key].description when provided.
    // If omitted, the server defaults to: "Filter results by {key}."
    "language": {
      "type": "string",
      "description": "Filter results by language.",
      "enum": ["go", "java", "python", "typescript"]
    },
    "scope": {
      "type": "string",
      "description": "Filter results by scope.",
      "enum": ["global-guide", "sdk-specific"]
    }
  },
  "required": ["query"]
}
```

**Success Response (MCP `CallToolResult`):**
Returns a single `TextContent` block. The `text` field contains a JSON-serialized `SearchResult` string. Providing structured JSON ensures agents can deterministically parse scores, metadata, and fallback hints.

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"hits\": [...],\n  \"next_cursor\": \"eyJv...\",\n  \"hint\": null\n}"
    }
  ],
  "isError": false
}
```

**Shape of the inner `SearchResult` JSON string:**

```typescript
{
  hits: Array<{
    chunk_id: string;      // Use this ID with get_doc
    score: number;         // Relevance score (useful for NDCG@5 eval)
    heading: string;       // The immediate heading for this chunk
    breadcrumb: string;    // e.g., "Authentication > OAuth > Login"
    snippet: string;       // The matched text (potentially highlighted/truncated)
    filepath: string;      // The source markdown file
    metadata: Record<string, string>; // The taxonomy values for this chunk
  }>;

  // Opaque base64 token for the next page. Null if no more results.
  next_cursor: string | null;

  // Structured fallback hint if hits.length === 0, guiding the agent.
  hint: {
    message: string;       // e.g., "0 results found for scope 'sdk-specific'."
    suggested_filters: Record<string, string[]>; // e.g., { "language": ["typescript", "python"] }
  } | null;
}
```

---

### 2. Tool: `get_doc`

**Purpose:** Fetches a specific markdown chunk by its deterministic ID. It allows the agent to expand its context window by retrieving adjacent chunks within the same file without loading the entire monolithic document.

**Tool Name:** `get_doc`
**Tool Description:** `Retrieve the full content of a specific documentation chunk using its chunk_id. You can optionally request surrounding context within the same file.`

**Input Schema:**

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "chunk_id": {
      "type": "string",
      "description": "The exact ID of the chunk to retrieve, as returned by search_docs (e.g., 'guides/retries.md#backoff-strategy')."
    },
    "context": {
      "type": "integer",
      "description": "Number of adjacent chunks to include before and after the target chunk. Default is 0. Use this to read the surrounding file context.",
      "minimum": 0,
      "maximum": 5,
      "default": 0
    }
  },
  "required": ["chunk_id"]
}
```

**Success Response (MCP `CallToolResult`):**
Returns a `TextContent` block. The text is formatted as markdown so the agent can read it naturally. Positional metadata (`Chunk X of Y`) is included in the delimiter so the agent understands its location in the document.

```json
{
  "content": [
    {
      "type": "text",
      "text": "--- Chunk: guides/retries.md#_preamble (Chunk 1 of 5) (Context: -1) ---\n# Retries\nThis guide explains how to configure retries.\n\n--- Chunk: guides/retries.md#backoff-strategy (Chunk 2 of 5) (Target) ---\n### Backoff Strategy\nThe SDK uses an exponential backoff...\n\n--- Chunk: guides/retries.md#jitter (Chunk 3 of 5) (Context: +1) ---\n### Jitter\nTo prevent thundering herds, jitter is applied..."
    }
  ],
  "isError": false
}
```

**Error Response (`isError: true`):**
Errors are returned as freetext in the `text` field. The message should be human-readable and actionable.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Chunk ID 'guides/retries.md#does-not-exist' not found. Use search_docs to discover valid chunk IDs."
    }
  ],
  "isError": true
}
```

Error cases:

- **Chunk not found:** The `chunk_id` does not match any indexed chunk.
- **Invalid format:** The `chunk_id` does not match the expected `{filepath}` or `{filepath}#{heading-path}` pattern.

#### Delimiter Grammar

The `get_doc` success response uses a stable delimiter format for chunk boundaries. The eval harness and any programmatic consumers may rely on this grammar:

```
--- Chunk: {chunk_id} (Chunk {1-indexed position} of {file_total}) (Target|Context: {+N|-N}) ---
```

- `{chunk_id}`: The deterministic chunk identifier, usable with `get_doc` or matchable against `search_docs` results.
- `Chunk {N} of {M}`: 1-indexed position within the source file.
- `Target`: The requested chunk. Exactly one delimiter per response carries this label.
- `Context: {+N|-N}`: A context chunk. `+1` means one chunk after the target, `-1` means one before.
