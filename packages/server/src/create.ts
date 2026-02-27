import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DocsIndex,
  LanceDbSearchEngine,
  createEmbeddingProvider,
  getCollapseKeys,
  normalizeMetadata,
  type Chunk,
  type CorpusMetadata,
  type EmbeddingMetadata,
  type EmbeddingProvider,
  type SearchEngine
} from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "./server.js";
import type { CustomTool } from "./types.js";

const TaxonomyFieldSchema = z.object({
  description: z.string().optional(),
  values: z.array(z.string())
}).passthrough();

const MetadataDocumentSchema = z.object({
  metadata_version: z.string(),
  corpus_description: z.string(),
  taxonomy: z.record(z.string(), TaxonomyFieldSchema),
  stats: z.object({
    total_chunks: z.number().int(),
    total_files: z.number().int(),
    indexed_at: z.string(),
    source_commit: z.string().nullable().optional()
  }).passthrough(),
  embedding: z.object({
    provider: z.string(),
    model: z.string(),
    dimensions: z.number().int()
  }).nullable(),
  tool_descriptions: z.object({
    search_docs: z.string().optional(),
    get_doc: z.string().optional()
  }).optional(),
  index: z.object({
    path: z.string(),
    table: z.string()
  }).optional()
}).passthrough();

const CustomToolSchema = z.object({
  name: z.string().regex(
    /^[a-zA-Z0-9_-]{1,64}$/,
    "tool name must match MCP spec: alphanumeric/dash/underscore, 1-64 chars"
  ),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).refine(
    (s) => s.type === "object",
    "inputSchema.type must be 'object' (required by MCP tool listing)"
  ),
  handler: z.function({ input: z.tuple([z.unknown()]), output: z.promise(z.any()) })
});

/** Zod schema for `createDocsServer()` options. Consumers can use this to validate config. */
export const CreateDocsServerOptionsSchema = z.object({
  /** Directory containing chunks.json and metadata.json produced by `docs-mcp build`. */
  indexDir: z.string().min(1, "indexDir must be a non-empty string"),

  /**
   * Prefix prepended to tool names, e.g. `"acme"` → `acme_search_docs`.
   * Must be alphanumeric/dash/underscore. Final tool name length is checked
   * against the 64-char MCP limit at construction time.
   */
  toolPrefix: z.string()
    .regex(/^[a-zA-Z0-9_-]+$/, "toolPrefix must be alphanumeric, dash, or underscore")
    .optional(),

  /** API key for query-time embeddings. Falls back to `OPENAI_API_KEY` env var. */
  queryEmbeddingApiKey: z.string().optional(),

  /** Base URL for the embedding API. */
  queryEmbeddingBaseUrl: z.string().url().optional(),

  /** Batch size for query embedding requests. Must be a positive integer. */
  queryEmbeddingBatchSize: z.number().int().positive().optional(),

  /**
   * Lexical phrase blend weight for RRF ranking.
   * Must be positive. Only passed to the engine when set.
   */
  proximityWeight: z.number().positive().optional(),

  /**
   * Phrase query slop (how many words apart terms can be).
   * Integer 0–5.
   */
  phraseSlop: z.number().int().min(0).max(5).optional(),

  /**
   * Vector rank blend weight for RRF ranking.
   * Must be positive. Only passed to the engine when set.
   */
  vectorWeight: z.number().positive().optional(),

  /**
   * Allow fallback to in-memory `chunks.json` search when `.lancedb` index is missing.
   * @default false
   */
  allowChunksFallback: z.boolean().default(false),

  /** Additional tools to register alongside the built-in search_docs and get_doc. */
  customTools: z.array(CustomToolSchema).default([])
});

/** What consumers pass to `createDocsServer()` — defaults are optional. */
export type CreateDocsServerOptionsInput = z.input<typeof CreateDocsServerOptionsSchema>;

/** Resolved options after Zod parse — defaults applied. */
export type CreateDocsServerOptions = z.output<typeof CreateDocsServerOptionsSchema>;

/**
 * Create a fully-configured `McpDocsServer` from a directory produced by `docs-mcp build`.
 *
 * This is the primary programmatic entry point. It loads metadata, resolves embedding providers,
 * opens the search engine, and returns a server ready to be passed to `startStdioServer()` or
 * `startHttpServer()`.
 */
export async function createDocsServer(input: CreateDocsServerOptionsInput): Promise<McpDocsServer> {
  const options = CreateDocsServerOptionsSchema.parse(input);

  const indexDir = path.resolve(options.indexDir);
  const metadataPath = path.join(indexDir, "metadata.json");
  const chunksPath = path.join(indexDir, "chunks.json");

  if (!(await exists(indexDir))) {
    throw new Error(`indexDir does not exist: '${indexDir}'`);
  }
  if (!(await exists(metadataPath))) {
    throw new Error(`metadata.json not found in indexDir: '${metadataPath}'`);
  }

  const metadataRaw = await readFile(metadataPath, "utf8");
  let metadataDocument: Record<string, unknown>;
  try {
    metadataDocument = MetadataDocumentSchema.parse(JSON.parse(metadataRaw));
  } catch (error) {
    const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
    throw new Error(`Invalid metadata.json at '${metadataPath}':\n${detail}`, { cause: error });
  }
  const metadata = normalizeMetadata(metadataDocument as unknown as CorpusMetadata) as CorpusMetadata;
  const metadataKeys = Object.keys(metadata.taxonomy);
  const collapseKeys = getCollapseKeys(metadata.taxonomy);
  const indexConfig = parseIndexConfig(metadataDocument);
  const queryEmbeddingProvider = resolveQueryEmbeddingProvider(options, metadata.embedding);

  const loadInput: {
    lancedbPath: string;
    tableName: string;
    chunksPath: string;
    metadataKeys: string[];
    collapseKeys: string[];
    queryEmbeddingProvider?: EmbeddingProvider;
    proximityWeight?: number;
    phraseSlop?: number;
    vectorWeight?: number;
    allowChunksFallback: boolean;
  } = {
    lancedbPath: path.resolve(indexDir, indexConfig.path),
    tableName: indexConfig.table,
    chunksPath,
    metadataKeys,
    collapseKeys,
    allowChunksFallback: options.allowChunksFallback
  };
  if (queryEmbeddingProvider !== undefined) {
    loadInput.queryEmbeddingProvider = queryEmbeddingProvider;
  }
  if (options.proximityWeight !== undefined) {
    loadInput.proximityWeight = options.proximityWeight;
  }
  if (options.phraseSlop !== undefined) {
    loadInput.phraseSlop = options.phraseSlop;
  }
  if (options.vectorWeight !== undefined) {
    loadInput.vectorWeight = options.vectorWeight;
  }

  const index = await loadSearchEngine(loadInput);

  return new McpDocsServer({
    index,
    metadata,
    vectorSearchAvailable: queryEmbeddingProvider !== undefined && queryEmbeddingProvider.name !== "hash",
    ...(options.toolPrefix ? { toolPrefix: options.toolPrefix } : {}),
    ...(options.customTools.length > 0
      ? { customTools: options.customTools as CustomTool[] }
      : {})
  });
}

async function loadSearchEngine(input: {
  lancedbPath: string;
  tableName: string;
  chunksPath: string;
  metadataKeys: string[];
  collapseKeys: string[];
  queryEmbeddingProvider?: EmbeddingProvider;
  proximityWeight?: number;
  phraseSlop?: number;
  vectorWeight?: number;
  allowChunksFallback: boolean;
}): Promise<SearchEngine> {
  if (await exists(input.lancedbPath)) {
    const openInput: {
      dbPath: string;
      tableName: string;
      metadataKeys: string[];
      collapseKeys?: string[];
      queryEmbeddingProvider?: EmbeddingProvider;
      proximityWeight?: number;
      phraseSlop?: number;
      vectorWeight?: number;
      onWarning?: (message: string) => void;
    } = {
      dbPath: input.lancedbPath,
      tableName: input.tableName,
      metadataKeys: input.metadataKeys,
      ...(input.collapseKeys.length > 0 ? { collapseKeys: input.collapseKeys } : {}),
      onWarning: (message: string) => console.warn(`warn: ${message}`)
    };
    if (input.queryEmbeddingProvider !== undefined) {
      openInput.queryEmbeddingProvider = input.queryEmbeddingProvider;
    }
    if (input.proximityWeight !== undefined) {
      openInput.proximityWeight = input.proximityWeight;
    }
    if (input.phraseSlop !== undefined) {
      openInput.phraseSlop = input.phraseSlop;
    }
    if (input.vectorWeight !== undefined) {
      openInput.vectorWeight = input.vectorWeight;
    }

    return LanceDbSearchEngine.open(openInput);
  }

  if (!input.allowChunksFallback) {
    throw new Error(
      `LanceDB index not found at '${input.lancedbPath}'. Re-run docs-mcp build or pass --allow-chunks-fallback to use chunks.json fallback.`
    );
  }

  console.warn(
    `warn: LanceDB index not found at '${input.lancedbPath}'; falling back to chunks.json in-memory search`
  );
  const chunksRaw = await readFile(input.chunksPath, "utf8");
  const chunks = JSON.parse(chunksRaw) as Chunk[];
  return new DocsIndex(chunks, {
    ...(input.collapseKeys.length > 0 ? { collapseKeys: input.collapseKeys } : {})
  });
}

function parseIndexConfig(metadata: Record<string, unknown>): { path: string; table: string } {
  const index = metadata.index;
  if (!index || typeof index !== "object") {
    return {
      path: ".lancedb",
      table: "chunks"
    };
  }

  const record = index as Record<string, unknown>;
  return {
    path: toNonEmptyString(record.path) ?? ".lancedb",
    table: toNonEmptyString(record.table) ?? "chunks"
  };
}

function resolveQueryEmbeddingProvider(
  options: { queryEmbeddingApiKey?: string | undefined; queryEmbeddingBaseUrl?: string | undefined; queryEmbeddingBatchSize?: number | undefined },
  metadataEmbedding: EmbeddingMetadata | null
): EmbeddingProvider | undefined {
  const provider = metadataEmbedding?.provider?.trim().toLowerCase();
  if (!provider || provider === "none") {
    return undefined;
  }

  if (provider !== "hash" && provider !== "openai") {
    console.warn(
      `warn: embedding provider '${metadataEmbedding?.provider}' is not supported at runtime; falling back to FTS-only search`
    );
    return undefined;
  }

  const input: {
    provider: "hash" | "openai";
    model?: string;
    dimensions?: number;
    apiKey?: string;
    baseUrl?: string;
    batchSize?: number;
  } = {
    provider
  };

  if (metadataEmbedding?.model !== undefined) {
    input.model = metadataEmbedding.model;
  }

  if (metadataEmbedding?.dimensions !== undefined) {
    input.dimensions = metadataEmbedding.dimensions;
  }

  const apiKey =
    options.queryEmbeddingApiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey !== undefined) {
    input.apiKey = apiKey;
  }

  if (options.queryEmbeddingBaseUrl !== undefined) {
    input.baseUrl = options.queryEmbeddingBaseUrl;
  }

  if (options.queryEmbeddingBatchSize !== undefined) {
    input.batchSize = options.queryEmbeddingBatchSize;
  }

  try {
    return createEmbeddingProvider(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warn: query embedding disabled: ${message}`);
    return undefined;
  }
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
