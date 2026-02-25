<div align="center">
 <a href="https://www.speakeasy.com/" target="_blank">
  <img width="1500" height="500" alt="Speakeasy" src="https://github.com/user-attachments/assets/0e56055b-02a3-4476-9130-4be299e5a39c" />
 </a>
 <br />
 <br />
<div>
<a href="https://go.speakeasy.com/slack" target="_blank"><b>Join us on Slack</b></a>
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

# Usage

## CLI

```bash
npm install -g @speakeasy-api/docs-mcp-cli
```

Refer to the [CLI documentation](./packages/cli/README.md) for usage instructions.

