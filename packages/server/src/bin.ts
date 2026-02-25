#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod/v4";
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
  type RrfWeights,
  type SearchEngine
} from "@speakeasy-api/docs-mcp-core";
import { McpDocsServer } from "./server.js";
import { startStdioServer } from "./stdio.js";
import { startHttpServer } from "./http.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as { version: string };

interface ServerCliOptions {
  indexDir: string;
  name: string;
  toolPrefix?: string;
  version: string;
  queryEmbeddingApiKey?: string;
  queryEmbeddingBaseUrl?: string;
  queryEmbeddingBatchSize?: number;
  proximityWeight?: number;
  phraseSlop?: number;
  vectorWeight?: number;
  allowChunksFallback: boolean;
  transport: "stdio" | "http";
  port: number;
}

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
  index: z.object({
    path: z.string(),
    table: z.string()
  }).optional()
}).passthrough();

const program = new Command();

program
  .name("docs-mcp-server")
  .description("Run @speakeasy-api/docs-mcp-server over MCP stdio transport")
  .requiredOption("--index-dir <path>", "Directory containing chunks.json and metadata.json")
  .option("--name <value>", "MCP server name", "@speakeasy-api/docs-mcp-server")
  .option("--tool-prefix <value>", "Tool name prefix (e.g. 'acme' produces acme_search_docs)")
  .option("--version <value>", "MCP server version", SERVER_VERSION)
  .option(
    "--query-embedding-api-key <value>",
    "Query embedding API key (or set OPENAI_API_KEY)"
  )
  .option("--query-embedding-base-url <value>", "Query embedding API base URL")
  .option("--query-embedding-batch-size <number>", "Query embedding batch size", parseIntOption)
  .option("--proximity-weight <number>", "Lexical phrase blend weight", parseNumberOption)
  .option("--phrase-slop <number>", "Phrase query slop (0-5)", parseNumberOption)
  .option("--vector-weight <number>", "Vector rank blend weight", parseNumberOption)
  .option(
    "--allow-chunks-fallback",
    "Allow fallback to chunks.json when .lancedb is missing",
    false
  )
  .option("--transport <type>", "Transport type: stdio or http", "stdio")
  .option("--port <number>", "HTTP server port (only used with --transport http)", parseIntOption, 20310)
  .action(async (options: ServerCliOptions) => {
    const indexDir = path.resolve(options.indexDir);
    const metadataPath = path.join(indexDir, "metadata.json");
    const chunksPath = path.join(indexDir, "chunks.json");

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

    const rrfWeights = parseRrfWeightsFromEnv();
    const app = new McpDocsServer({
      index,
      metadata,
      vectorSearchAvailable: queryEmbeddingProvider !== undefined && queryEmbeddingProvider.name !== "hash",
      ...(options.toolPrefix ? { toolPrefix: options.toolPrefix } : {}),
      ...(rrfWeights ? { rrfWeights } : {})
    });

    const serverName = options.name === "@speakeasy-api/docs-mcp-server" && options.toolPrefix
      ? `${options.toolPrefix}-docs-server`
      : options.name;

    if (options.transport === "http") {
      await startHttpServer(app, {
        name: serverName,
        version: options.version,
        port: options.port
      });
    } else {
      await startStdioServer(app, {
        name: serverName,
        version: options.version
      });
    }
  });

void program.parseAsync(process.argv);

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
  options: ServerCliOptions,
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

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric value '${value}'`);
  }
  return parsed;
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid integer value '${value}'`);
  }
  return parsed;
}

function parseRrfWeightsFromEnv(): RrfWeights | undefined {
  const vector = parseOptionalEnvFloat("RRF_WEIGHT_VECTOR");
  const match = parseOptionalEnvFloat("RRF_WEIGHT_MATCH");
  const phrase = parseOptionalEnvFloat("RRF_WEIGHT_PHRASE");

  if (vector === undefined && match === undefined && phrase === undefined) {
    return undefined;
  }

  const weights: RrfWeights = {};
  if (vector !== undefined) {
    weights.vector = vector;
  }
  if (match !== undefined) {
    weights.match = match;
  }
  if (phrase !== undefined) {
    weights.phrase = phrase;
  }
  return weights;
}

function parseOptionalEnvFloat(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`warn: ignoring invalid ${name} value '${raw}'`);
    return undefined;
  }
  return parsed;
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
