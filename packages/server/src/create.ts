import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LanceDbSearchEngine,
  createEmbeddingProvider,
  getCollapseKeys,
  normalizeMetadata,
  type Chunk,
  type CorpusMetadata,
  type EmbeddingMetadata,
  type EmbeddingProvider,
  type SearchEngine,
} from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "./server.js";
import { LlmsGoSearchEngine } from "./llms-go-search.js";
import type { CustomTool } from "./types.js";

const TaxonomyFieldSchema = z
  .object({
    description: z.string().optional(),
    values: z.array(z.string()),
  })
  .passthrough();

const MetadataDocumentSchema = z
  .object({
    metadata_version: z.string(),
    corpus_description: z.string(),
    taxonomy: z.record(z.string(), TaxonomyFieldSchema),
    stats: z
      .object({
        total_chunks: z.number().int(),
        total_files: z.number().int(),
        indexed_at: z.string(),
        source_commit: z.string().nullable().optional(),
      })
      .passthrough(),
    embedding: z
      .object({
        provider: z.string(),
        model: z.string(),
        dimensions: z.number().int(),
      })
      .nullable(),
    tool_descriptions: z
      .object({
        search_docs: z.string().optional(),
        get_doc: z.string().optional(),
      })
      .optional(),
    index: z
      .object({
        path: z.string(),
        table: z.string(),
      })
      .optional(),
  })
  .passthrough();

const CustomToolSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]{1,64}$/,
      "tool name must match MCP spec: alphanumeric/dash/underscore, 1-64 chars",
    ),
  description: z.string().min(1),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine(
      (s) => s.type === "object",
      "inputSchema.type must be 'object' (required by MCP tool listing)",
    ),
  handler: z.function({ input: z.tuple([z.unknown(), z.any()]), output: z.promise(z.any()) }),
});

/** Zod schema for `createDocsServer()` options. Consumers can use this to validate config. */
export const CreateDocsServerOptionsSchema = z.object({
  /** Directory containing chunks.json and metadata.json produced by `docs-mcp build`. */
  indexDir: z.string().min(1, "indexDir must be a non-empty string"),

  /**
   * Prefix prepended to built-in tool names, e.g. `"acme"` → `acme_search_docs`.
   * Does not affect custom tool names. Must be alphanumeric/dash/underscore.
   * Final tool name length is checked against the 64-char MCP limit at construction time.
   */
  toolPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "toolPrefix must be alphanumeric, dash, or underscore")
    .optional(),

  /** API key for query-time embeddings. Falls back to `OPENAI_API_KEY` env var. */
  queryEmbeddingApiKey: z.string().optional(),

  /**
   * Base URL for the embedding API. Defaults to the provider's official endpoint
   * (e.g. `https://api.openai.com/v1` for OpenAI). Override to use a proxy or compatible API.
   */
  queryEmbeddingBaseUrl: z.string().url().optional(),

  /**
   * Number of texts per embedding API call. Reduce if hitting provider rate or payload limits.
   * Must be a positive integer.
   * @default 128
   */
  queryEmbeddingBatchSize: z.number().int().positive().optional(),

  /**
   * RRF blend weight for lexical phrase-proximity matches. Higher values boost
   * results where query terms appear close together. Must be positive.
   * @default 1.25
   */
  proximityWeight: z.number().positive().optional(),

  /**
   * Maximum word distance allowed for phrase matches (0 = exact phrase only, up to 5).
   * @default 0
   */
  phraseSlop: z.number().int().min(0).max(5).optional(),

  /**
   * RRF blend weight for vector (semantic) search results. Higher values boost
   * semantically similar results. Must be positive.
   * @default 1
   */
  vectorWeight: z.number().positive().optional(),

  /** Additional tools to register alongside the built-in search_docs and get_doc. */
  customTools: z.array(CustomToolSchema).default([]),
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
export async function createDocsServer(
  input: CreateDocsServerOptionsInput,
): Promise<McpDocsServer> {
  const options = CreateDocsServerOptionsSchema.parse(input);

  const indexDir = path.resolve(options.indexDir);
  const metadataPath = path.join(indexDir, "metadata.json");

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
  const metadata = normalizeMetadata(
    metadataDocument as unknown as CorpusMetadata,
  ) as CorpusMetadata;
  const metadataKeys = Object.keys(metadata.taxonomy);
  const collapseKeys = getCollapseKeys(metadata.taxonomy);
  const indexConfig = parseIndexConfig(metadataDocument);
  const queryEmbeddingProvider = resolveQueryEmbeddingProvider(options, metadata.embedding);

  const loadInput: {
    lancedbPath: string;
    tableName: string;
    metadataKeys: string[];
    collapseKeys: string[];
    queryEmbeddingProvider?: EmbeddingProvider;
    proximityWeight?: number;
    phraseSlop?: number;
    vectorWeight?: number;
  } = {
    lancedbPath: path.resolve(indexDir, indexConfig.path),
    tableName: indexConfig.table,
    metadataKeys,
    collapseKeys,
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

  const baseIndex = await loadSearchEngine(loadInput);

  const llmsGoConfig = parseLlmsGoConfig(metadataDocument);
  const index = llmsGoConfig
    ? await wrapWithLlmsGoSearch({
        baseIndex,
        chunksPath: path.join(indexDir, "chunks.json"),
        registryPath: path.resolve(indexDir, llmsGoConfig.registryPath),
      })
    : baseIndex;

  return new McpDocsServer({
    index,
    metadata,
    vectorSearchAvailable:
      queryEmbeddingProvider !== undefined && queryEmbeddingProvider.name !== "hash",
    ...(options.toolPrefix ? { toolPrefix: options.toolPrefix } : {}),
    ...(options.customTools.length > 0 ? { customTools: options.customTools as CustomTool[] } : {}),
  });
}

async function loadSearchEngine(input: {
  lancedbPath: string;
  tableName: string;
  metadataKeys: string[];
  collapseKeys: string[];
  queryEmbeddingProvider?: EmbeddingProvider;
  proximityWeight?: number;
  phraseSlop?: number;
  vectorWeight?: number;
}): Promise<SearchEngine> {
  if (!(await exists(input.lancedbPath))) {
    throw new Error(
      `LanceDB index not found at '${input.lancedbPath}'. Re-run docs-mcp build to generate the index.`,
    );
  }

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
    onWarning: (message: string) => console.warn(`warn: ${message}`),
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

function parseIndexConfig(metadata: Record<string, unknown>): { path: string; table: string } {
  const index = metadata.index;
  if (!index || typeof index !== "object") {
    return {
      path: ".lancedb",
      table: "chunks",
    };
  }

  const record = index as Record<string, unknown>;
  return {
    path: toNonEmptyString(record.path) ?? ".lancedb",
    table: toNonEmptyString(record.table) ?? "chunks",
  };
}

function resolveQueryEmbeddingProvider(
  options: {
    queryEmbeddingApiKey?: string | undefined;
    queryEmbeddingBaseUrl?: string | undefined;
    queryEmbeddingBatchSize?: number | undefined;
  },
  metadataEmbedding: EmbeddingMetadata | null,
): EmbeddingProvider | undefined {
  const provider = metadataEmbedding?.provider?.trim().toLowerCase();
  if (!provider || provider === "none") {
    return undefined;
  }

  if (provider !== "hash" && provider !== "openai") {
    console.warn(
      `warn: embedding provider '${metadataEmbedding?.provider}' is not supported at runtime; falling back to FTS-only search`,
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
    provider,
  };

  if (metadataEmbedding?.model !== undefined) {
    input.model = metadataEmbedding.model;
  }

  if (metadataEmbedding?.dimensions !== undefined) {
    input.dimensions = metadataEmbedding.dimensions;
  }

  const apiKey = options.queryEmbeddingApiKey ?? process.env.OPENAI_API_KEY;
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

async function wrapWithLlmsGoSearch(input: {
  baseIndex: SearchEngine;
  chunksPath: string;
  registryPath: string;
}): Promise<SearchEngine> {
  const chunksRaw = await readFile(input.chunksPath, "utf8");
  const chunks = JSON.parse(chunksRaw) as Chunk[];
  const registryRaw = await readFile(input.registryPath, "utf8");
  const registry = parseRegistrySymbols(registryRaw);
  return new LlmsGoSearchEngine(input.baseIndex, {
    chunks,
    registrySymbols: registry,
  });
}

function parseLlmsGoConfig(
  metadata: Record<string, unknown>,
): { registryPath: string } | null {
  const block = metadata.llms_go;
  if (!block || typeof block !== "object") {
    return null;
  }
  const record = block as Record<string, unknown>;
  const registryPath = toNonEmptyString(record.registry_path);
  if (!registryPath) {
    return null;
  }
  return { registryPath };
}

function parseRegistrySymbols(source: string): Array<{ id: string; uses?: string[] }> {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const symbols = (parsed as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) {
    return [];
  }
  const out: Array<{ id: string; uses?: string[] }> = [];
  for (const item of symbols) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = toNonEmptyString((item as Record<string, unknown>).id);
    if (!id) {
      continue;
    }
    const usesRaw = (item as Record<string, unknown>).uses;
    const uses = Array.isArray(usesRaw)
      ? usesRaw.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    out.push({ id, ...(uses ? { uses } : {}) });
  }
  return out;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
