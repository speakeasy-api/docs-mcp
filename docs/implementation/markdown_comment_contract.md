# Contract: Markdown Include Directives

## Purpose

Inline source files into indexed markdown at build time. The expanded content participates in chunking, embedding, and search like any other prose.

Primary use case: enriching model/type reference pages with actual source definitions so agents find concrete type signatures, field constraints, and defaults — not just prose summaries.

## Scope

- Include tags are resolved during `docs-mcp build` (and checked by `docs-mcp validate`).
- Expanded markdown is what gets chunked, embedded, and indexed.
- The MCP server is unaware of include tags — it sees normal chunks.

## Tag Format

HTML comments with space-separated `key=value` attributes, matching the Speakeasy template comment convention (e.g. `UsageSnippet`):

```md
<!-- SourceRef path=../src/models/user.ts -->
```

### Attributes

| Attribute   | Type    | Required | Default  | Description                                              |
| ----------- | ------- | -------- | -------- | -------------------------------------------------------- |
| `path`      | string  | yes      | —        | Source file path, resolved relative to the markdown file |
| `startLine` | integer | no       | 1        | First line to include (1-indexed)                        |
| `endLine`   | integer | no       | EOF      | Last line to include (inclusive)                         |
| `lang`      | string  | no       | inferred | Code fence language tag override                         |

Values are bare tokens or double-quoted strings (for values containing spaces). Unknown attributes are rejected.

### Examples

Simple include:

```md
<!-- SourceRef path=../src/models/user.ts -->
```

With line range and language override:

```md
<!-- SourceRef path=../src/config.go startLine=10 endLine=45 lang=go -->
```

Speakeasy template source (before rendering):

```
<!-- SourceRef path={{stringify $modelSourcePath}} lang={{stringify $.Global.Config.Language}} -->
```

### Expansion

The tag is replaced with a fenced code block. A `// ref:` comment is included to give agents a search-friendly path to locate the file in the installed package or repo:

````md
```typescript
// ref: src/models/user.ts
export interface UserRequest {
  na[markdown_comment_contract.md](markdown_comment_contract.md)me: string;
  email: string;
  role?: "admin" | "member";
}
```
````

#### `ref` derivation

The `ref` is the resolved file path expressed relative to the **common ancestor** of `--docs-dir` and the resolved source file. This common ancestor is typically the repo/package root — the same root an agent sees when the package is installed as a dependency.

Example: given `--docs-dir=repo/docs` and a markdown file at `docs/models/user-request.md`:

```
<!-- SourceRef path=../src/models/user.ts -->
```

1. Resolve `../src/models/user.ts` from `docs/models/` → `repo/src/models/user.ts`
2. Common ancestor of `repo/docs/` and `repo/src/models/user.ts` → `repo/`
3. `ref` = `src/models/user.ts`

The agent can then `glob **/src/models/user.ts` or even just `**/models/user.ts` to find the file regardless of whether it's in `src/`, `dist/`, or `lib/` in the installed package. The suffix is what matters — it's stable across build layouts.

#### Other expansion rules

- `lang`: tag value if provided, otherwise inferred from extension (`.ts` → `typescript`, `.go` → `go`, `.py` → `python`, `.java` → `java`, etc.).
- `// ref:` comment syntax adapts to language (`#` for Python/Ruby/Bash, `--` for SQL).
- When `startLine`/`endLine` are set, only that range is included. Out-of-bounds values are clamped silently.

## Path Resolution

All paths are resolved **relative to the markdown file's directory**. This is the only resolution mode.

The template engine is responsible for rendering correct relative paths using its own context (e.g. `repoSubdirectory`). `docs-mcp` consumes fully rendered markdown.

Resolved paths may traverse outside `--docs-dir` (this is expected — source files live alongside docs, not inside the docs directory). However, the resolved path must exist and be readable at build time. `.md` targets are rejected (no recursive inlining).

## Build Pipeline Integration

Expansion runs after manifest resolution, before chunking:

```
for each markdown file:
  1. read file
  2. resolve config (manifest + overrides + frontmatter)
  3. expand SourceRef tags → modified markdown
  4. compute fingerprint (on expanded markdown)
  5. chunk
```

The fingerprint is computed on **expanded** markdown. If the referenced source file changes, the fingerprint changes and the chunk is re-embedded. If unchanged, cached embeddings are reused.

File reads are cached in-memory for the duration of a single build (same path referenced by multiple files is read once).

### Errors

| Condition                      | Behavior                   |
| ------------------------------ | -------------------------- |
| File not found                 | Build error.               |
| Target is a `.md` file         | Build error.               |
| Malformed tag / missing `path` | Build error with location. |
| Unknown attributes             | Build error.               |
| Line range out of bounds       | Silently clamped.          |

## Interaction with Existing Features

- **Chunking**: Expanded code block is a single `code` AST node. The chunker never bisects nodes, so inlined blocks stay whole. Normal `max_chunk_size` overflow handling applies.
- **`get_doc`**: No changes. Inlined content is part of the chunk's `content` field.
- **Embedding**: Source code becomes part of `content_text` and the embedding input, improving semantic retrieval for code-oriented queries.
- **Incremental builds**: Fully compatible via fingerprint-based invalidation.
