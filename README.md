<div align="center">
  <a href="https://www.speakeasy.com/" target="_blank">
    <img
      width="1500"
      height="500"
      alt="Speakeasy"
      src="https://github.com/user-attachments/assets/0e56055b-02a3-4476-9130-4be299e5a39c"
    />
  </a>
  <br />
  <br />
  <div>
    <a href="https://www.speakeasy.com/product/sdk-generation" target="_blank">
      <b>Generate SDKs</b>
    </a>
    &nbsp;&nbsp;//&nbsp;&nbsp;
    <a href="https://go.speakeasy.com/slack" target="_blank">
      <b>Join us on Slack</b>
    </a>
  </div>
</div>

<br />

# Docs MCP

A lightweight, domain-agnostic embedded search engine exposed via the Model
Context Protocol (MCP).

## Features

- **Hybrid search.** Combines full-text search, phrase matching,
  and vector similarity to deliver highly relevant results.
- **Markdown-aware chunking.** Splits documents intelligently by headings or file,
  never breaking code blocks or losing structure.
- **Fully local operation.** No external API calls at runtime. Everything is indexed
  at build time and queried locally for fast, offline searches.
- **Context-aware schemas.** Automatically adapts search tools and filters to your
  data’s taxonomy, exposing valid filter values in the schema.
- **Self-correcting zero-result handling.** When a search returns nothing, it
  suggests alternative filters to guide agents toward better queries.
- **Contextual document retrieval.** Fetches a document chunk along with its
  surrounding context, ensuring searches return coherent sections.
- **Flexible embedding options.** Supports multiple embedding backends: OpenAI,
  deterministic local hashing, or purely text-based mode.
- **Configurable with manifests.** Uses a layered configuration system with
  file-based overrides, frontmatter hints, and inline directives.
- **Reproducible builds.** Embedding results are cached, so only changed documents
  are reprocessed for consistent, incremental builds.
- **Works anywhere.** Runs over stdio or HTTP (JSON-RPC 2.0), compatible with any
  MCP host environment.

## How it Works

Docs MCP is a generator for MCP servers: you point it at a corpus of markdown
docs, and it produces a ready‑to‑run MCP server that turns your existing docs
into a live, structured knowledge source for AI clients. The generated server
crawls your content, normalizes it into an index of endpoints, guides, and
examples, and exposes that structure over MCP so models can discover available
operations, pull in the most relevant documentation on demand, and answer
questions with concrete, API‑aware detail—all without you hand‑writing tools or
duplicating any of your docs.

## Getting Started

### Prerequisites

- **Node.js >= 22**
- **An embedding provider (optional).** For best search quality, set an
  `OPENAI_API_KEY` environment variable. If you don't have one, the CLI supports
  a free deterministic `hash` provider or a text-only `none` mode — see the
  [CLI documentation](./packages/cli/README.md) for details on all providers.

### Step 1: Build the Index

Point the CLI at a directory of markdown files to produce a search index:

```bash
npx @speakeasy-api/docs-mcp-cli build \
  --docs-dir ./docs \
  --out ./dist \
  --embedding-provider openai          # or "hash" / "none"
```

This reads your markdown, chunks it intelligently, generates embeddings, and
writes the index artifacts to `./dist`.

### Step 2: Start the MCP Server

Run the server against the index you just built:

```bash
npx @speakeasy-api/docs-mcp-server \
  --index-dir ./dist \
  --transport http \
  --port 20310
```

Your MCP server is now live at `http://localhost:20310/mcp`. Any MCP-compatible
client can connect to it. For stdio transport (e.g. Claude Desktop), omit the
`--transport` and `--port` flags.

### Step 3: Explore with the Playground

The playground gives you a web UI for testing searches against your running
server:

```bash
npx @speakeasy-api/docs-mcp-playground
```

Open [http://localhost:3001](http://localhost:3001) in your browser. The
playground proxies requests to `http://localhost:20310` by default — set
`MCP_TARGET` to point it elsewhere.

## Deploying

The recommended deployment pattern bakes the index into a Docker image at build
time so the server starts instantly with zero external dependencies.

### Dockerfile

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
COPY docs /corpus
RUN docs-mcp build --docs-dir /corpus --out /index --embedding-provider hash
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

### CI Example (GitHub Actions)

Add a step to your workflow that builds and pushes the image whenever your docs
change:

```yaml
name: Deploy Docs MCP
on:
  push:
    branches: [main]
    paths: [docs/**]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push Docker image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: your-registry/docs-mcp:latest
```

Drop the Dockerfile above into your repo root, replace `your-registry` with
your container registry, and your docs MCP server will rebuild and deploy on
every push to `main` that touches the `docs/` directory.

## Reference

For full CLI flags and configuration options, see the package docs:

- [CLI documentation](./packages/cli/README.md)
- [Server documentation](./packages/server/README.md)
- [Playground documentation](./packages/playground/README.md)

