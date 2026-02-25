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

## Quickstart

Requires Node.js >= 22. For best results set `OPENAI_API_KEY`, or use
`--embedding-provider hash` for a free local alternative.

```bash
# 1. Build an index from your markdown docs
OPENAI_API_KEY=sk-... npx @speakeasy-api/docs-mcp-cli build \
  --docs-dir ./docs --out ./dist --embedding-provider openai

# 2. Start the MCP server
npx @speakeasy-api/docs-mcp-server --index-dir ./dist --transport http --port 20310

# 3. Open the playground at http://localhost:3001
npx @speakeasy-api/docs-mcp-playground
```

For stdio transport (e.g. Claude Desktop), omit `--transport` and `--port`.

## Creating an Image

```dockerfile
FROM node:22-slim
RUN npm install -g @speakeasy-api/docs-mcp-cli @speakeasy-api/docs-mcp-server
ARG DOCS_DIR=docs
COPY ${DOCS_DIR} /corpus
RUN --mount=type=secret,id=OPENAI_API_KEY \
    OPENAI_API_KEY=$(cat /run/secrets/OPENAI_API_KEY) \
    docs-mcp build --docs-dir /corpus --out /index --embedding-provider openai
EXPOSE 20310
CMD ["docs-mcp-server", "--index-dir", "/index", "--transport", "http", "--port", "20310"]
```

```bash
# Build the image
docker build --secret id=OPENAI_API_KEY,env=OPENAI_API_KEY \
  --build-arg DOCS_DIR=./docs -t docs-mcp .

# Run the server
docker run -p 20310:20310 docs-mcp
```

## Reference

- [CLI docs](./packages/cli/README.md)
- [Server docs](./packages/server/README.md)
- [Playground docs](./packages/playground/README.md)

