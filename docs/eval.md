# Evaluation Framework (`docs-mcp-eval`)

The `@speakeasy-api/docs-mcp-eval` framework validates retrieval quality with transparent, repeatable benchmarks. It is built as an independent Turborepo package that imports `@speakeasy-api/docs-mcp-server` and simulates a real agent interacting with the system via stdio.

## Core Metrics

The `docs-mcp-eval` tool drives the MCP server directly via stdio JSON-RPC (simulating a real agent) and captures the following metrics. All values are recorded and compared as deltas against a prior baseline; there are no fixed pass/fail thresholds.

### 1. Latency (Speed)
*   **Average Search (p50):** The median time taken to execute a `search_docs` call.
*   **Tail Latency (p95):** The 95th percentile latency.
*   **Context Fetch (p50):** The time taken to execute a `get_doc` call for a specific chunk ID.

### 2. Efficiency (Resource Usage)
*   **Peak Memory Usage:** The maximum RSS (Resident Set Size) memory consumed by the Node.js process during a heavy search workload. Validates that LanceDB's memory-mapped I/O is functioning correctly and preventing V8 heap bloat.
*   **Index Build Time:** The time required to parse, chunk, embed, and construct the `.lancedb` directory for the standard fixture corpus.

### 3. Agent Efficacy (Accuracy)
*   **MRR@5 (Mean Reciprocal Rank):** The average reciprocal of the rank at which the first correct chunk appears in the top 5 results. A score of 1.0 means the correct chunk is always the top result.
*   **NDCG@5 (Normalized Discounted Cumulative Gain):** Measures ranking quality across the top 5 results, accounting for the position of all relevant chunks, not just the first.
*   **Avg Rounds to Right Doc:** How many tool calls (`search_docs` followed by `get_doc`) does it take a simulated agent to retrieve the exact chunk containing the answer to a predefined question? A lower number means higher signal-to-noise ratio.
*   **Taxonomy/Facet Precision:** Validates the JSON Schema injection and LanceDB pre-filtering. If an eval queries for "pagination" but strictly requires `language: "python"`, the framework asserts that *zero* TypeScript documents are returned.

## Corpus Fixtures

The framework runs against a fixed, version-controlled documentation corpus:

*   **Standard Fixture (`tests/fixtures/realistic/`):** A small (~5MB) curated slice of Speakeasy SDK documentation covering multiple languages (TS, Python, Go) for a single service. Used for fast CI runs and validating cross-language deduplication logic.

## The `docs-mcp-eval` CLI

### Execution Flow
1.  **Initialize:** Spin up the TS MCP Server process as a child process using stdio.
2.  **Warm-up:** Send random `search_docs` queries to warm up the V8 JIT compiler and OS page cache (mmap).
3.  **Benchmarking:** Execute a suite of predefined queries (JSON objects containing the query, optional taxonomy filters, and the expected `chunk_id`).
4.  **Measurement:** Record execution time for each JSON-RPC request/response cycle. Poll the child process PID for RSS memory usage.
5.  **Reporting:** Output a markdown-formatted report summarizing the metrics.

### Example Eval Suite Definition

```json
[
  {
    "name": "Exact Class Match (FTS Dominance)",
    "query": "AcmeAuthClientV2 initialization",
    "filters": { "language": "typescript" },
    "expected_chunk_id": "sdks/typescript/auth.md#acmeauthclientv2",
    "max_rounds_allowed": 1
  },
  {
    "name": "Conceptual Search (Vector Dominance)",
    "query": "how do I handle rate limits and 429s",
    "filters": {},
    "expected_chunk_id": "guides/rate-limiting.md#handling-429-errors",
    "max_rounds_allowed": 2
  }
]
```

### Delta Reporting

The eval runner produces a markdown delta table comparing the current run's metrics against a baseline. Example output:

```
| Metric              | main     | PR       | Delta   |
|---------------------|----------|----------|---------|
| Search p50          | 12.3ms   | 14.1ms   | +14.6%  |
| Search p95          | 18.7ms   | 19.2ms   | +2.7%   |
| Peak RSS            | 142MB    | 145MB    | +2.1%   |
| Avg Rounds          | 2.1      | 2.1      | 0%      |
| Facet Precision     | pass     | pass     | —       |
```

No hard pass/fail gates — the delta table gives reviewers the data to make informed decisions.
