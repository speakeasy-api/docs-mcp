# Realistic Eval Fixture (Starter)

This starter fixture provides a small multi-language corpus for end-to-end eval runs.

- Languages: `typescript`, `python`, `go`
- Includes global guides and sdk-specific references
- Chunking: `h2` via distributed manifests

Run example:

```bash
node packages/cli/dist/index.js build \
  --docs-dir packages/eval/fixtures/realistic \
  --out /tmp/docs-mcp-index \
  --embedding-provider hash \
  --embedding-dimensions 256

node packages/eval/dist/bin.js \
  --cases packages/eval/fixtures/realistic/cases.json \
  --server-command node \
  --server-arg packages/server/dist/bin.js \
  --server-arg --index-dir \
  --server-arg /tmp/docs-mcp-index \
  --server-arg --query-embedding-provider \
  --server-arg hash \
  --server-arg --query-embedding-dimensions \
  --server-arg 256 \
  --warmup-queries 10
```

This fixture is intended as a reproducible baseline seed. Expand it for the full delivery-gate corpus.
