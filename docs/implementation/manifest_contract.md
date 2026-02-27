# Contract: `.docs-mcp.json`

## Purpose

This document defines the schema, composition rules, and precedence hierarchy for the `.docs-mcp.json` file. These manifests are distributed throughout the markdown corpus to dictate how files should be chunked and what metadata should be attached to them.

## Schema Definition

The manifest is a versioned JSON object that defines baseline rules for its directory, with an `overrides` array for exceptions.

```json
{
  "version": "1",
  "metadata": {
    "language": "typescript",
    "scope": "sdk-specific"
  },
  "strategy": {
    "chunk_by": "h2",
    "max_chunk_size": 8000,
    "min_chunk_size": 200
  },
  "overrides": [
    {
      "pattern": "models/**/*.md",
      "strategy": {
        "chunk_by": "file"
      }
    },
    {
      "pattern": "guides/advanced/*.md",
      "metadata": {
        "scope": "global-guide"
      }
    }
  ]
}
```

### Fields

- **`version`**: (Required) Currently strictly `"1"`. Ensures future parser compatibility.
- **`metadata`**: (Optional) The baseline metadata record applied to any markdown file in this directory tree.
- **`strategy`**: (Optional) The baseline `ChunkingStrategy` applied to any markdown file in this directory tree.
  - **`chunk_by`**: (Required within strategy) The heading level at which to split: `"h1"`, `"h2"`, `"h3"`, or `"file"` (no split).
  - **`max_chunk_size`**: (Optional) Character limit. If a single DOM node exceeds this, the indexer applies a fallback split to prevent oversized chunks.
  - **`min_chunk_size`**: (Optional) Character floor. Tiny trailing chunks below this threshold are merged into the preceding chunk.
- **`overrides`**: (Optional) An array of objects mapping glob `pattern`s to specific `strategy` and `metadata` overrides.

## Resolution Rules

To ensure predictable and fast builds, the chunking and metadata resolution follows strict precedence and matching rules.

### 1. Precedence Hierarchy (What overrides what)

When the indexer evaluates a specific markdown file, it resolves the chunking strategy and metadata from highest priority to lowest:

1.  **YAML Frontmatter (Highest):** If a file contains explicit `mcp_chunking_hint` or metadata keys in its YAML frontmatter, these are merged with precedence over any manifest configurations for that specific file. Frontmatter keys win; manifest keys not present in frontmatter are preserved.
2.  **Manifest `overrides` Match:** If the file matches a glob `pattern` in the `overrides` array of the nearest manifest.
    - **Merging:** The override `metadata` is merged with the root `metadata` (override keys win). The override `strategy` replaces the root `strategy`.
3.  **Manifest Baseline:** The root `strategy` and `metadata` fields in the nearest manifest.
4.  **Global System Defaults (Lowest):** (e.g., `chunk_by: "h2"`).

### 2. Directory Composition (Nearest Ancestor Wins)

Manifests **do not merge across directories**.
If `/docs/.docs-mcp.json` and `/docs/sdks/typescript/.docs-mcp.json` both exist, a file located at `/docs/sdks/typescript/auth.md` is governed **exclusively** by the TypeScript folder's manifest. The parent `/docs` manifest is completely ignored for that subtree. This prevents complex, hard-to-debug inheritance chains.

### 3. Glob Matching within Overrides (Last-Match Wins)

Within a single `.docs-mcp.json`, the `overrides` array is evaluated from top to bottom. If a file path matches multiple glob patterns, the **last matching entry wins**. This allows authors to define broad catch-all rules at the top and specific exceptions at the bottom.
Override `pattern` matching is evaluated against the file path **relative to the directory containing that manifest**.

## System Boundaries

- **Written by:** Authors manually, or automatically bootstrapped/repaired by the `@speakeasy-api/docs-mcp-cli` (`docs-mcp fix` command).
- **Read by:** `@speakeasy-api/docs-mcp-cli` (specifically the `corpus-walker`) during the `validate` and `build` commands.
- **Never read by:** `@speakeasy-api/docs-mcp-server`. The runtime server only knows about the resulting `Chunk` and its indexed `metadata.json`.
