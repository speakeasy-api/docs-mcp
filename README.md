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

## Usage

### CLI

```bash
npm install -g @speakeasy-api/docs-mcp-cli
```

Refer to the [CLI documentation](./packages/cli/README.md) for usage instructions.

