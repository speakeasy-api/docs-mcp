# Evaluation Framework (`docs-mcp-eval`)

The `@speakeasy-api/docs-mcp-eval` framework validates retrieval quality with transparent, repeatable benchmarks. It is built as an independent Turborepo package that imports `@speakeasy-api/docs-mcp-server` and simulates a real agent interacting with the system via stdio.

## Core Metrics

The `docs-mcp-eval` tool drives the MCP server directly via stdio JSON-RPC (simulating a real agent) and captures the following metrics. All values are recorded and compared as deltas against a prior baseline; there are no fixed pass/fail thresholds.

### 1. Latency (Speed)

- **Average Search (p50):** The median time taken to execute a `search_docs` call.
- **Tail Latency (p95):** The 95th percentile latency.
- **Context Fetch (p50):** The time taken to execute a `get_doc` call for a specific chunk ID.

### 2. Efficiency (Resource Usage)

- **Peak Memory Usage:** The maximum RSS (Resident Set Size) memory consumed by the Node.js process during a heavy search workload. Validates that LanceDB's memory-mapped I/O is functioning correctly and preventing V8 heap bloat.
- **Index Build Time:** The time required to parse, chunk, embed, and construct the `.lancedb` directory for the standard fixture corpus.

### 3. Agent Efficacy (Accuracy)

- **MRR@5 (Mean Reciprocal Rank):** The average reciprocal of the rank at which the first correct chunk appears in the top 5 results. A score of 1.0 means the correct chunk is always the top result.
- **NDCG@5 (Normalized Discounted Cumulative Gain):** Measures ranking quality across the top 5 results, accounting for the position of all relevant chunks, not just the first.
- **Avg Rounds to Right Doc:** How many tool calls (`search_docs` followed by `get_doc`) does it take a simulated agent to retrieve the exact chunk containing the answer to a predefined question? A lower number means higher signal-to-noise ratio.
- **Taxonomy/Facet Precision:** Validates the JSON Schema injection and LanceDB pre-filtering. If an eval queries for "pagination" but strictly requires `language: "python"`, the framework asserts that _zero_ TypeScript documents are returned.

## Corpus Fixtures

The framework runs against a fixed, version-controlled documentation corpus:

- **Standard Fixture (`tests/fixtures/realistic/`):** A small (~5MB) curated slice of Speakeasy SDK documentation covering multiple languages (TS, Python, Go) for a single service. Used for fast CI runs and validating cross-language deduplication logic.

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

## Building an Eval Suite

An eval suite is a JSON array of test cases. Each case describes a query, optional filters, and the chunk ID that should appear in the results.

### Case Format

```json
[
  {
    "name": "Exact Class Match",
    "category": "lexical",
    "query": "AcmeAuthClientV2 initialization",
    "expectedChunkId": "sdks/typescript/auth.md#typescript-auth-sdk/acmeauthclientv2-initialization",
    "filters": { "language": "typescript" },
    "limit": 5,
    "maxRounds": 2
  },
  {
    "name": "Conceptual Retry Query",
    "category": "intent",
    "query": "retry configuration",
    "expectedChunkId": "sdks/python/auth.md#python-auth-sdk/retry-configuration",
    "filters": { "language": "python" },
    "limit": 5,
    "maxRounds": 2
  }
]
```

### Fields

| Field             | Required | Description                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| `query`           | yes      | The search query to send to `search_docs`                                       |
| `expectedChunkId` | yes      | The chunk ID that should appear in the results. Format: `filepath#heading-slug` |
| `filters`         | no       | Taxonomy filters to pass (e.g. `{"language": "python"}`). Defaults to `{}`      |
| `limit`           | no       | Number of results per page. Defaults to 5                                       |
| `maxRounds`       | no       | Maximum pagination rounds before giving up. Defaults to 3                       |
| `name`            | no       | Human-readable name for reporting                                               |
| `category`        | no       | Category tag for per-category breakdown analysis                                |

### Choosing Categories

Categories enable per-category metric breakdowns, revealing where your search engine excels and where it struggles. Common categories:

| Category         | Tests                                          | Example query                                      |
| ---------------- | ---------------------------------------------- | -------------------------------------------------- |
| `lexical`        | Exact keyword / class name matches             | `"AcmeAuthClientV2 initialization"`                |
| `paraphrased`    | Semantically equivalent but differently worded | `"how do I handle 429 rate limits"`                |
| `intent`         | Conceptual queries requiring understanding     | `"retry configuration"`                            |
| `sdk-reference`  | SDK-specific API lookups                       | `"list organizations method"`                      |
| `cross-service`  | Queries spanning multiple services             | `"authentication across services"`                 |
| `multi-hop`      | Requires connecting multiple chunks            | `"pagination with retry on failure"`               |
| `distractor`     | Queries with plausible but wrong matches       | `"authentication" (expecting auth guide, not SDK)` |
| `error-handling` | Error code and exception lookups               | `"ERR_RATE_LIMIT handling"`                        |
| `api-discovery`  | Finding available operations                   | `"what endpoints are available"`                   |

## Running Benchmarks

### Single Eval Run

Run an eval suite against a single server configuration:

```bash
npx docs-mcp-eval run \
  --cases ./eval-cases.json \
  --server-command "node packages/server/dist/bin.js --index-dir ./my-index"
```

Options:

- `--cases` — path to your eval suite JSON file (required)
- `--server-command` — command to launch the MCP server (required)
- `--build-command` — optional pre-eval index build step
- `--warmup-queries` — number of warmup searches before measurement (default: 0)
- `--baseline` — path to a previous eval result JSON for delta comparison
- `--out` — output path for the eval result JSON

### Multi-Embedding Benchmark

Compare search quality across embedding providers:

```bash
npx docs-mcp-eval benchmark \
  --cases ./eval-cases.json \
  --docs-dir ./my-docs \
  --work-dir ./benchmark-output \
  --build-command "npx docs-mcp build" \
  --server-command "npx docs-mcp-server" \
  --embeddings "none,openai/text-embedding-3-large" \
  --warmup-queries 3
```

This builds a separate index for each embedding provider, runs the full eval suite against each, and generates a comparison report. The `--embeddings` flag accepts a comma-separated list of specs in the format `provider` or `provider/model`.

## Interpreting Results

### MRR@5 (Mean Reciprocal Rank at 5)

The average of `1/rank` for the first correct result in the top 5. Measures how early the right answer appears.

- **1.0** — the correct chunk is always the #1 result
- **0.5** — correct chunk is typically at rank 2
- **0.0** — correct chunk never appears in the top 5

### NDCG@5 (Normalized Discounted Cumulative Gain at 5)

Like MRR but accounts for the full ranking quality, not just the first correct result. Uses logarithmic discounting — a wrong result at rank 1 is penalized more heavily than at rank 5.

### Facet Precision

The fraction of eval cases where the expected chunk appears anywhere in the top 5 results. A simple retrieval success rate.

- **1.0** — every eval case found its expected chunk
- **0.5** — half the cases found the expected chunk

### Per-Category Breakdowns

The most actionable output. Per-category tables reveal which query types benefit from embeddings and which are already well-served by FTS alone. For example, `lexical` queries often perform identically with or without embeddings, while `paraphrased` and `intent` queries show significant improvement with semantic search.
