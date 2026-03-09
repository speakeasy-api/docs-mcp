import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Parsed attributes from a SourceRef HTML comment directive.
 */
export interface SourceRefDirective {
  path: string;
  startLine?: number;
  endLine?: number;
  lang?: string;
}

/**
 * Options for expanding SourceRef directives in markdown.
 */
export interface ExpandSourceRefsOptions {
  /** Absolute path to the directory containing the markdown file. */
  markdownDir: string;
  /** Absolute path to --docs-dir. Used to compute `ref` paths. */
  docsDir: string;
  /** In-memory cache of source file contents keyed by absolute path. */
  fileCache?: Map<string, string>;
}

const KNOWN_ATTRIBUTES = new Set(["path", "startLine", "endLine", "lang"]);

/**
 * Matches `<!-- SourceRef key=value ... -->` comments. The inner content
 * (between `SourceRef` and `-->`) is captured for attribute parsing.
 */
const SOURCE_REF_RE = /<!--\s*SourceRef\s+(.*?)\s*-->/g;

/**
 * Maps file extensions to markdown code fence language tags.
 */
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".py": "python",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".rs": "rust",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".lua": "lua",
  ".php": "php",
  ".r": "r",
  ".R": "r",
  ".dart": "dart",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
};

/**
 * Languages that use `#` for single-line comments.
 */
const HASH_COMMENT_LANGS = new Set(["python", "ruby", "bash", "r", "elixir", "yaml", "toml"]);

/**
 * Languages that use `--` for single-line comments.
 */
const DASH_COMMENT_LANGS = new Set(["sql", "lua"]);

/**
 * Returns the appropriate single-line comment prefix for a language.
 */
function commentPrefix(lang: string): string {
  if (HASH_COMMENT_LANGS.has(lang)) return "#";
  if (DASH_COMMENT_LANGS.has(lang)) return "--";
  return "//";
}

/**
 * Infers a code fence language tag from a file extension.
 */
export function inferLang(filePath: string): string {
  const ext = path.extname(filePath);
  return EXT_TO_LANG[ext] ?? ext.replace(/^\./, "");
}

/**
 * Parses the attribute string from a SourceRef comment into a structured directive.
 * Throws on malformed input, missing `path`, or unknown attributes.
 */
export function parseSourceRefAttributes(raw: string): SourceRefDirective {
  const attrs: Record<string, string> = {};

  // Tokenize: key=value or key="value with spaces"
  const tokenRe = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = tokenRe.exec(raw)) !== null) {
    // Check for unexpected content between tokens
    const gap = raw.slice(lastIndex, match.index).trim();
    if (gap.length > 0) {
      throw new Error(`Malformed SourceRef: unexpected content '${gap}'`);
    }
    const key = match[1]!;
    const value = match[2] ?? match[3]!;
    if (!KNOWN_ATTRIBUTES.has(key)) {
      throw new Error(`Unknown SourceRef attribute '${key}'`);
    }
    attrs[key] = value;
    lastIndex = tokenRe.lastIndex;
  }

  // Check trailing content
  const trailing = raw.slice(lastIndex).trim();
  if (trailing.length > 0) {
    throw new Error(`Malformed SourceRef: unexpected content '${trailing}'`);
  }

  if (!attrs["path"]) {
    throw new Error("SourceRef missing required 'path' attribute");
  }

  const directive: SourceRefDirective = { path: attrs["path"] };

  if (attrs["startLine"] !== undefined) {
    const n = Number(attrs["startLine"]);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `SourceRef startLine must be a positive integer, got '${attrs["startLine"]}'`,
      );
    }
    directive.startLine = n;
  }

  if (attrs["endLine"] !== undefined) {
    const n = Number(attrs["endLine"]);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`SourceRef endLine must be a positive integer, got '${attrs["endLine"]}'`);
    }
    directive.endLine = n;
  }

  if (attrs["lang"] !== undefined) {
    directive.lang = attrs["lang"];
  }

  return directive;
}

/**
 * Computes the `ref` path: the resolved source file expressed relative to
 * the common ancestor of docsDir and the source file.
 */
function computeRefPath(resolvedSource: string, docsDir: string): string {
  // Find common ancestor between docsDir and resolvedSource
  const docsParts = path.resolve(docsDir).split(path.sep);
  const sourceParts = path.resolve(resolvedSource).split(path.sep);

  let commonLength = 0;
  for (let i = 0; i < Math.min(docsParts.length, sourceParts.length); i++) {
    if (docsParts[i] === sourceParts[i]) {
      commonLength = i + 1;
    } else {
      break;
    }
  }

  const commonAncestor = docsParts.slice(0, commonLength).join(path.sep);
  return path.relative(commonAncestor, resolvedSource).split(path.sep).join("/");
}

/**
 * Expands a single SourceRef directive into a fenced code block.
 */
function expandDirective(
  directive: SourceRefDirective,
  opts: ExpandSourceRefsOptions,
  location: string,
): string {
  const resolved = path.resolve(opts.markdownDir, directive.path);

  // Reject .md targets
  if (path.extname(resolved).toLowerCase() === ".md") {
    throw new Error(
      `${location}: SourceRef target '${directive.path}' is a .md file (recursive inlining not allowed)`,
    );
  }

  // Read source file (with caching)
  let content: string;
  const cache = opts.fileCache;
  if (cache?.has(resolved)) {
    content = cache.get(resolved)!;
  } else {
    try {
      content = readFileSync(resolved, "utf8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`${location}: SourceRef file not found: ${resolved}`);
      }
      throw new Error(
        `${location}: SourceRef failed to read '${resolved}': ${(err as Error).message}`,
      );
    }
    cache?.set(resolved, content);
  }

  // Extract line range
  const lines = content.split("\n");
  const start = Math.max(1, directive.startLine ?? 1);
  const end = Math.min(lines.length, directive.endLine ?? lines.length);
  const slice = lines.slice(start - 1, end);

  // Determine language
  const lang = directive.lang ?? inferLang(resolved);

  // Compute ref path
  const ref = computeRefPath(resolved, opts.docsDir);
  const prefix = commentPrefix(lang);

  // Build fenced code block
  const refLine = `${prefix} ref: ${ref}`;
  const codeContent = [refLine, ...slice].join("\n");
  return `\`\`\`${lang}\n${codeContent}\n\`\`\``;
}

/**
 * Expands all SourceRef directives in a markdown string.
 * Returns the expanded markdown with directives replaced by fenced code blocks.
 *
 * @throws On any error (missing file, malformed tag, .md target, unknown attrs).
 */
export function expandSourceRefs(markdown: string, opts: ExpandSourceRefsOptions): string {
  const errors: string[] = [];

  const result = markdown.replace(SOURCE_REF_RE, (fullMatch, attrs: string, offset: number) => {
    // Compute line number for error messages
    const lineNum = markdown.slice(0, offset).split("\n").length;
    const location = `line ${lineNum}`;

    try {
      const directive = parseSourceRefAttributes(attrs);
      return expandDirective(directive, opts, location);
    } catch (err: unknown) {
      errors.push((err as Error).message);
      return fullMatch; // preserve original on error so we can report all errors
    }
  });

  if (errors.length > 0) {
    throw new Error(`SourceRef expansion errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return result;
}
