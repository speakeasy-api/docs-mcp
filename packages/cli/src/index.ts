#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import fg from "fast-glob";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../package.json") as { version: string };
import {
  buildLanceDbIndex,
  buildChunks,
  createEmbeddingProvider,
  embedChunksIncremental,
  loadCache,
  parseManifestJson,
  resolveFileConfig,
  saveCache,
  type Chunk,
  type EmbeddingMetadata,
  type Manifest
} from "@speakeasy-api/docs-mcp-core";
import { buildHeuristicManifest } from "./fix.js";
import { resolveSourceCommit } from "./git.js";

const program = new Command();

program
  .name("docs-mcp")
  .description("Speakeasy MCP docs authoring and indexing CLI")
  .version(CLI_VERSION);

program
  .command("validate")
  .description("Validate markdown chunking and manifest resolution")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .action(async (options: { docsDir: string }) => {
    const docsDir = path.resolve(options.docsDir);
    const files = await listMarkdownFiles(docsDir);
    const manifestCache = new Map<string, Manifest>();

    let warnings = 0;
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      const relative = toPosix(path.relative(docsDir, file));
      const manifestContext = await loadNearestManifest(file, docsDir, manifestCache);
      const resolved = resolveFileConfig({
        relativeFilePath: relative,
        markdown,
        ...(manifestContext
          ? {
              manifest: manifestContext.manifest,
              manifestBaseDir: manifestContext.manifestBaseDir
            }
          : {})
      });

      if (!manifestContext) {
        warnings += 1;
        console.warn(`warn: no manifest found for ${relative}; using default strategy '${resolved.strategy.chunk_by}'`);
      }

      buildChunks({
        filepath: relative,
        markdown,
        strategy: resolved.strategy,
        metadata: resolved.metadata
      });
    }

    console.log(`validated ${files.length} markdown files`);
    if (warnings > 0) {
      console.log(`completed with ${warnings} warning(s)`);
    }
  });

program
  .command("build")
  .description("Build deterministic index artifacts from a markdown corpus")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .requiredOption("--out <path>", "Output directory")
  .option("--description <value>", "Corpus description", "Documentation corpus")
  .option("--embedding-provider <provider>", "Embedding provider: none | hash | openai", "none")
  .option("--embedding-model <value>", "Embedding model override")
  .option("--embedding-dimensions <number>", "Embedding dimensions", parseIntOption)
  .option("--embedding-api-key <value>", "Embedding API key (or set OPENAI_API_KEY)")
  .option("--embedding-base-url <value>", "Embedding API base URL")
  .option("--embedding-batch-size <number>", "Embedding batch size", parseIntOption)
  .option("--embedding-concurrency <number>", "Embedding request concurrency", parseIntOption)
  .option("--embedding-max-retries <number>", "Embedding max retries for 429/5xx", parseIntOption)
  .option("--rebuild-cache", "Skip cache read and re-embed all chunks (still writes a fresh cache)")
  .option("--cache-dir <path>", "Directory for .embedding-cache/ (defaults to --out path)")
  .action(async (options: {
    docsDir: string;
    out: string;
    description: string;
    embeddingProvider: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    embeddingApiKey?: string;
    embeddingBaseUrl?: string;
    embeddingBatchSize?: number;
    embeddingConcurrency?: number;
    embeddingMaxRetries?: number;
    rebuildCache?: boolean;
    cacheDir?: string;
  }) => {
    const docsDir = path.resolve(options.docsDir);
    const outDir = path.resolve(options.out);
    const files = await listMarkdownFiles(docsDir);
    const manifestCache = new Map<string, Manifest>();

    const chunks: Chunk[] = [];
    for (const file of files) {
      const markdown = await readFile(file, "utf8");
      const relative = toPosix(path.relative(docsDir, file));
      const manifestContext = await loadNearestManifest(file, docsDir, manifestCache);
      const resolved = resolveFileConfig({
        relativeFilePath: relative,
        markdown,
        ...(manifestContext
          ? {
              manifest: manifestContext.manifest,
              manifestBaseDir: manifestContext.manifestBaseDir
            }
          : {})
      });

      const fileChunks = buildChunks({
        filepath: relative,
        markdown,
        strategy: resolved.strategy,
        metadata: resolved.metadata
      });
      chunks.push(...fileChunks);
    }

    const providerInput: {
      provider: "none" | "hash" | "openai";
      model?: string;
      dimensions?: number;
      apiKey?: string;
      baseUrl?: string;
      batchSize?: number;
      concurrency?: number;
      maxRetries?: number;
    } = {
      provider: normalizeProvider(options.embeddingProvider)
    };
    if (options.embeddingModel !== undefined) {
      providerInput.model = options.embeddingModel;
    }
    if (options.embeddingDimensions !== undefined) {
      providerInput.dimensions = options.embeddingDimensions;
    }
    if (options.embeddingBaseUrl !== undefined) {
      providerInput.baseUrl = options.embeddingBaseUrl;
    }
    if (options.embeddingBatchSize !== undefined) {
      providerInput.batchSize = options.embeddingBatchSize;
    }
    if (options.embeddingConcurrency !== undefined) {
      providerInput.concurrency = options.embeddingConcurrency;
    }
    if (options.embeddingMaxRetries !== undefined) {
      providerInput.maxRetries = options.embeddingMaxRetries;
    }
    const apiKey = options.embeddingApiKey ?? process.env.OPENAI_API_KEY;
    if (apiKey !== undefined) {
      providerInput.apiKey = apiKey;
    }

    const embeddingProvider = createEmbeddingProvider(providerInput);

    await mkdir(outDir, { recursive: true });
    const cacheBaseDir = path.resolve(options.cacheDir ?? outDir);

    let vectorsByChunkId: Map<string, number[]> | undefined;

    if (embeddingProvider.name !== "none") {
      const config = {
        provider: embeddingProvider.name,
        model: embeddingProvider.model,
        dimensions: embeddingProvider.dimensions,
        configFingerprint: embeddingProvider.configFingerprint,
      };

      // Load cache (skip when --rebuild-cache)
      const cache = options.rebuildCache ? null : await loadCache(cacheBaseDir, config);

      const embedStart = Date.now();
      const result = await embedChunksIncremental(
        chunks,
        { ...config, embed: (texts) => embeddingProvider.embed(texts) },
        cache,
      );
      const embedMs = ((Date.now() - embedStart) / 1000).toFixed(1);

      vectorsByChunkId = result.vectorsByChunkId;

      // Emit stats to stderr on every run
      const { stats } = result;
      const hitRate = stats.total > 0
        ? ((stats.hits / stats.total) * 100).toFixed(1)
        : "0.0";
      console.warn(`embedding cache: ${stats.hits} hits, ${stats.misses} misses (${hitRate}% hit rate)`);
      if (stats.misses > 0) {
        console.warn(`embedded ${stats.misses} chunks via ${embeddingProvider.name} in ${embedMs}s`);
      }

      // Save cache (always — even with --rebuild-cache to warm future builds).
      // Non-critical: a failed cache write shouldn't abort the build since the
      // index output is already computed.
      try {
        await saveCache(cacheBaseDir, result.updatedCache, config);
      } catch (err) {
        console.warn(`warn: failed to write embedding cache: ${err instanceof Error ? err.message : err}`);
      }
    }

    const embeddingMetadata: EmbeddingMetadata | null =
      embeddingProvider.name === "none"
        ? null
        : {
            provider: embeddingProvider.name,
            model: embeddingProvider.model,
            dimensions: embeddingProvider.dimensions
          };

    const sourceCommit = await resolveSourceCommit(docsDir);
    const metadata = buildMetadata(
      chunks,
      files,
      options.description,
      embeddingMetadata,
      sourceCommit
    );
    const metadataKeys = Object.keys(metadata.taxonomy);
    const lanceDbPath = path.join(outDir, ".lancedb");

    const buildInput: {
      dbPath: string;
      chunks: Chunk[];
      metadataKeys: string[];
      vectorsByChunkId?: Map<string, number[]>;
    } = {
      dbPath: lanceDbPath,
      chunks,
      metadataKeys
    };
    if (vectorsByChunkId) {
      buildInput.vectorsByChunkId = vectorsByChunkId;
    }
    await buildLanceDbIndex(buildInput);

    await writeFile(path.join(outDir, "chunks.json"), JSON.stringify(chunks, null, 2));
    await writeFile(
      path.join(outDir, "metadata.json"),
      JSON.stringify(
        {
          ...metadata,
          index: {
            engine: "lancedb",
            table: "chunks",
            path: ".lancedb"
          }
        },
        null,
        2
      )
    );

    console.log(`wrote ${chunks.length} chunks and .lancedb index to ${outDir}`);
  });

program
  .command("fix")
  .description("Generate a baseline .mcp-manifest.json using deterministic heading heuristics")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .action(async (options: { docsDir: string }) => {
    const docsDir = path.resolve(options.docsDir);
    const manifestPath = path.join(docsDir, ".mcp-manifest.json");

    if (await exists(manifestPath)) {
      console.log(`manifest already exists: ${manifestPath}`);
      return;
    }

    const files = await listMarkdownFiles(docsDir);
    const manifestInput = await Promise.all(
      files.map(async (file) => {
        const relative = toPosix(path.relative(docsDir, file));
        const markdown = await readFile(file, "utf8");
        return {
          path: relative,
          markdown
        };
      })
    );
    const baseline: Manifest = buildHeuristicManifest(manifestInput);

    await writeFile(manifestPath, `${JSON.stringify(baseline, null, 2)}\n`);
    const overrideCount = baseline.overrides?.length ?? 0;
    console.log(
      `created ${manifestPath} (default=${baseline.strategy?.chunk_by ?? "h2"}, overrides=${overrideCount})`
    );
  });

void program.parseAsync(process.argv);

async function loadNearestManifest(
  filePath: string,
  docsDir: string,
  cache: Map<string, Manifest>
): Promise<{ manifest: Manifest; manifestBaseDir: string } | undefined> {
  let currentDir = path.dirname(filePath);
  const stopDir = path.resolve(docsDir);

  while (true) {
    const candidate = path.join(currentDir, ".mcp-manifest.json");
    if (await exists(candidate)) {
      const cached = cache.get(candidate);
      const manifest = cached ?? parseManifestJson(await readFile(candidate, "utf8"));
      if (!cached) {
        cache.set(candidate, manifest);
      }
      const relativeDir = toPosix(path.relative(stopDir, currentDir));
      return {
        manifest,
        manifestBaseDir: relativeDir || "."
      };
    }

    if (currentDir === stopDir) {
      break;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir || !isWithinDir(parent, stopDir)) {
      break;
    }

    currentDir = parent;
  }

  return undefined;
}

async function listMarkdownFiles(docsDir: string): Promise<string[]> {
  const files = await fg(["**/*.md"], {
    cwd: docsDir,
    absolute: true,
    onlyFiles: true,
    dot: false
  });
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function buildMetadata(
  chunks: Chunk[],
  files: string[],
  corpusDescription: string,
  embedding: EmbeddingMetadata | null,
  sourceCommit: string | null
): {
  metadata_version: string;
  corpus_description: string;
  taxonomy: Record<string, { description: string; values: string[] }>;
  stats: {
    total_chunks: number;
    total_files: number;
    indexed_at: string;
    source_commit: string | null;
  };
  embedding: EmbeddingMetadata | null;
} {
  const taxonomyValues = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const [key, value] of Object.entries(chunk.metadata)) {
      const values = taxonomyValues.get(key) ?? new Set<string>();
      values.add(value);
      taxonomyValues.set(key, values);
    }
  }

  const taxonomy: Record<string, { description: string; values: string[] }> = {};
  for (const [key, values] of taxonomyValues.entries()) {
    taxonomy[key] = {
      description: `Filter results by ${key}.`,
      values: [...values].sort((a, b) => a.localeCompare(b))
    };
  }

  return {
    metadata_version: "1.1.0",
    corpus_description: corpusDescription,
    taxonomy,
    stats: {
      total_chunks: chunks.length,
      total_files: files.length,
      indexed_at: new Date().toISOString(),
      source_commit: sourceCommit
    },
    embedding
  };
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got '${value}'`);
  }
  return parsed;
}

function normalizeProvider(value: string): "none" | "hash" | "openai" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "hash" || normalized === "openai") {
    return normalized;
  }

  throw new Error(
    `unsupported embedding provider '${value}'. Expected one of: none, hash, openai`
  );
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}

function isWithinDir(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
