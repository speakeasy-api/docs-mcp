#!/usr/bin/env node

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import fg from "fast-glob";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../package.json") as {
  version: string;
};
import {
  buildLanceDbIndex,
  buildChunks,
  computeChunkFingerprint,
  createEmbeddingProvider,
  embedChunksIncremental,
  formatDuration,
  loadCache,
  loadChunksFromPreviousIndex,
  mergeTaxonomyConfigs,
  parseManifestJson,
  resolveFileConfig,
  saveCache,
  type BatchProgressEvent,
  type Chunk,
  type EmbedProgressEvent,
  type EmbeddingMetadata,
  type ManifestTaxonomyFieldConfig,
  type IndexBuildStep,
  type Manifest,
  type PreviousIndexReader,
} from "@speakeasy-api/docs-mcp-core";
import { buildHeuristicManifest } from "./fix.js";
import { resolveCorpusLabel, resolveSourceCommit } from "./git.js";

const program = new Command();

const isTTY = process.stderr.isTTY ?? false;
let progressLineCount = 0;

function writeProgress(msg: string) {
  writeProgressBlock([msg]);
}

function writeProgressBlock(lines: string[]) {
  if (!isTTY) return;
  // Move cursor up to start of previous block
  if (progressLineCount > 1) {
    process.stderr.write(`\x1b[${progressLineCount - 1}A`);
  }
  // Write new lines, clearing each
  for (let i = 0; i < lines.length; i++) {
    process.stderr.write(`\r\x1b[K${lines[i]}`);
    if (i < lines.length - 1) process.stderr.write("\n");
  }
  // Clear any leftover lines from a previously taller block
  for (let i = lines.length; i < progressLineCount; i++) {
    process.stderr.write("\n\x1b[K");
  }
  const extra = progressLineCount - lines.length;
  if (extra > 0) {
    process.stderr.write(`\x1b[${extra}A`);
  }
  progressLineCount = lines.length;
}

function clearProgress() {
  if (!isTTY || progressLineCount === 0) return;
  if (progressLineCount > 1) {
    process.stderr.write(`\x1b[${progressLineCount - 1}A`);
  }
  process.stderr.write("\r\x1b[K");
  for (let i = 1; i < progressLineCount; i++) {
    process.stderr.write("\n\x1b[K");
  }
  if (progressLineCount > 1) {
    process.stderr.write(`\x1b[${progressLineCount - 1}A\r`);
  }
  progressLineCount = 0;
}

let lastNonTtyWrite = 0;

/**
 * Pack segments into lines that fit within `cols`, separating with `sep`.
 * Any single segment wider than `cols` is hard-truncated.
 */
function packLines(segments: string[], cols: number, sep = "  "): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const seg of segments) {
    const truncated = seg.length > cols ? seg.slice(0, cols) : seg;
    if (cur.length === 0) {
      cur = truncated;
    } else if (cur.length + sep.length + truncated.length <= cols) {
      cur += sep + truncated;
    } else {
      lines.push(cur);
      cur = truncated;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

function writeBatchProgress(event: BatchProgressEvent) {
  // Non-polling phases: always emit
  if (event.phase !== "batch-polling") {
    if (isTTY) {
      writeProgress(event.message);
    } else {
      console.warn(event.message);
    }
    return;
  }

  // Non-TTY: throttle to one line per ~10s
  if (!isTTY) {
    const now = Date.now();
    if (now - lastNonTtyWrite >= 10_000) {
      lastNonTtyWrite = now;
      console.warn(event.message);
    }
    return;
  }

  // TTY: read current width every call (terminal can be resized)
  const cols = process.stderr.columns || 80;

  // If the flat message fits, use it as-is
  if (event.message.length <= cols) {
    writeProgress(event.message);
    return;
  }

  // Build discrete segments and pack into as many lines as needed
  if (event.counts) {
    const { completed, total, failed } = event.counts;
    const pct = ((completed / total) * 100).toFixed(1);
    const segments = [`Batch: ${completed}/${total} (${pct}%)`];
    if (failed > 0) segments.push(`${failed} failed`);
    if (event.etaSec != null) segments.push(`ETA ~${formatDuration(event.etaSec)}`);
    if (event.elapsedSec != null) segments.push(`Elapsed: ${formatDuration(event.elapsedSec)}`);
    if (event.pollRemainingSec != null) segments.push(`Next poll: ${event.pollRemainingSec}s`);
    writeProgressBlock(packLines(segments, cols));
  } else {
    writeProgress(event.message);
  }
}

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
              manifestBaseDir: manifestContext.manifestBaseDir,
            }
          : {}),
      });

      if (!manifestContext) {
        warnings += 1;
        console.warn(
          `warn: no manifest found for ${relative}; using default strategy '${resolved.strategy.chunk_by}'`,
        );
      }

      buildChunks({
        filepath: relative,
        markdown,
        strategy: resolved.strategy,
        metadata: resolved.metadata,
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
  .option("--tool-description-search <value>", "Custom description for the search_docs MCP tool")
  .option("--tool-description-get-doc <value>", "Custom description for the get_doc MCP tool")
  .action(
    async (options: {
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
      toolDescriptionSearch?: string;
      toolDescriptionGetDoc?: string;
    }) => {
      const docsDir = path.resolve(options.docsDir);
      const outDir = path.resolve(options.out);
      const files = await listMarkdownFiles(docsDir);
      const manifestCache = new Map<string, Manifest>();
      const lanceDbPath = path.join(outDir, ".lancedb");
      const lanceDbTmpPath = path.join(outDir, ".lancedb.tmp");
      const lanceDbOldPath = path.join(outDir, ".lancedb.old");

      // Clean up stale tmp/old dirs from interrupted builds
      await rm(lanceDbTmpPath, { recursive: true, force: true });
      await rm(lanceDbOldPath, { recursive: true, force: true });

      // Load previous index for chunk caching (old .lancedb/ stays readable during build)
      let previousIndex: PreviousIndexReader | null = options.rebuildCache
        ? null
        : await loadChunksFromPreviousIndex(lanceDbPath);

      // Canary validation: re-chunk the first 10 fingerprint-matching files to
      // detect chunking logic changes without maintaining a version number.
      if (previousIndex) {
        let validated = 0;
        for (const file of files) {
          if (validated >= 10) break;
          const markdown = await readFile(file, "utf8");
          const relative = toPosix(path.relative(docsDir, file));
          const manifestContext = await loadNearestManifest(file, docsDir, manifestCache);
          const resolved = resolveFileConfig({
            relativeFilePath: relative,
            markdown,
            ...(manifestContext
              ? {
                  manifest: manifestContext.manifest,
                  manifestBaseDir: manifestContext.manifestBaseDir,
                }
              : {}),
          });

          const fingerprint = computeChunkFingerprint(
            markdown,
            resolved.strategy,
            resolved.metadata,
          );
          if (previousIndex.fingerprints.get(relative) !== fingerprint) continue;

          const freshChunks = buildChunks({
            filepath: relative,
            markdown,
            strategy: resolved.strategy,
            metadata: resolved.metadata,
          });
          const cachedChunks = await previousIndex.getChunks(relative);

          if (JSON.stringify(freshChunks) !== JSON.stringify(cachedChunks)) {
            console.warn(`warn: chunk cache canary mismatch for ${relative}; discarding cache`);
            previousIndex.close();
            previousIndex = null;
            break;
          }
          validated++;
        }
      }

      const chunks: Chunk[] = [];
      const newFileFingerprints: Record<string, string> = {};
      let chunkCacheHits = 0;
      for (let fi = 0; fi < files.length; fi++) {
        writeProgress(`Chunking [${fi + 1}/${files.length}]...`);
        const file = files[fi]!;
        const markdown = await readFile(file, "utf8");
        const relative = toPosix(path.relative(docsDir, file));
        const manifestContext = await loadNearestManifest(file, docsDir, manifestCache);
        const resolved = resolveFileConfig({
          relativeFilePath: relative,
          markdown,
          ...(manifestContext
            ? {
                manifest: manifestContext.manifest,
                manifestBaseDir: manifestContext.manifestBaseDir,
              }
            : {}),
        });

        const fingerprint = computeChunkFingerprint(markdown, resolved.strategy, resolved.metadata);
        newFileFingerprints[relative] = fingerprint;

        if (previousIndex?.fingerprints.get(relative) === fingerprint) {
          const cachedChunks = await previousIndex.getChunks(relative);
          chunks.push(...cachedChunks);
          chunkCacheHits++;
          continue;
        }

        const fileChunks = buildChunks({
          filepath: relative,
          markdown,
          strategy: resolved.strategy,
          metadata: resolved.metadata,
        });
        chunks.push(...fileChunks);
      }
      clearProgress();
      const cacheSuffix = chunkCacheHits > 0 ? ` (${chunkCacheHits} cached)` : "";
      console.warn(
        `Chunked ${files.length} files into ${chunks.length.toLocaleString()} chunks${cacheSuffix}`,
      );

      const taxonomyConfig = mergeTaxonomyConfigs(manifestCache.values());

      const onBatchProgress = (event: BatchProgressEvent) => {
        writeBatchProgress(event);
      };
      const providerInput: {
        provider: "none" | "hash" | "openai";
        model?: string;
        dimensions?: number;
        apiKey?: string;
        baseUrl?: string;
        batchSize?: number;
        batchApiThreshold?: number;
        batchName?: string;
        concurrency?: number;
        maxRetries?: number;
        onBatchProgress?: (event: BatchProgressEvent) => void;
      } = {
        provider: normalizeProvider(options.embeddingProvider),
        batchApiThreshold: 2500,
        batchName: `docs-mcp:${await resolveCorpusLabel(docsDir)}`,
        onBatchProgress,
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
        const onProgress = (event: EmbedProgressEvent) => {
          writeProgress(
            `Embedding [${event.completed}/${event.total}] (${event.cached} cached)...`,
          );
        };
        const result = await embedChunksIncremental(
          chunks,
          { ...config, embed: (texts) => embeddingProvider.embed(texts) },
          cache,
          {
            ...(embeddingProvider.batchSize !== undefined
              ? { batchSize: embeddingProvider.batchSize }
              : {}),
            ...(embeddingProvider.batchApiThreshold !== undefined
              ? { batchApiThreshold: embeddingProvider.batchApiThreshold }
              : {}),
            onProgress,
          },
        );
        clearProgress();
        const embedMs = ((Date.now() - embedStart) / 1000).toFixed(1);

        vectorsByChunkId = result.vectorsByChunkId;

        // Emit stats to stderr on every run
        const { stats } = result;
        const hitRate = stats.total > 0 ? ((stats.hits / stats.total) * 100).toFixed(1) : "0.0";
        console.warn(
          `embedding cache: ${stats.hits} hits, ${stats.misses} misses (${hitRate}% hit rate)`,
        );
        if (stats.misses > 0) {
          console.warn(
            `embedded ${stats.misses} chunks via ${embeddingProvider.name} in ${embedMs}s`,
          );
        }

        // Save cache (always — even with --rebuild-cache to warm future builds).
        // Non-critical: a failed cache write shouldn't abort the build since the
        // index output is already computed.
        try {
          await saveCache(cacheBaseDir, result.updatedCache, config);
        } catch (err) {
          console.warn(
            `warn: failed to write embedding cache: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      const embeddingMetadata: EmbeddingMetadata | null =
        embeddingProvider.name === "none"
          ? null
          : {
              provider: embeddingProvider.name,
              model: embeddingProvider.model,
              dimensions: embeddingProvider.dimensions,
            };

      const toolDescriptions: Record<string, string> = {};
      if (options.toolDescriptionSearch) {
        toolDescriptions.search_docs = options.toolDescriptionSearch;
      }
      if (options.toolDescriptionGetDoc) {
        toolDescriptions.get_doc = options.toolDescriptionGetDoc;
      }

      const sourceCommit = await resolveSourceCommit(docsDir);
      const metadata = buildMetadata(
        chunks,
        files,
        options.description,
        embeddingMetadata,
        sourceCommit,
        taxonomyConfig,
        Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
      );
      const metadataKeys = Object.keys(metadata.taxonomy);

      // Warn about taxonomy config keys that don't match any chunk metadata
      for (const key of Object.keys(taxonomyConfig)) {
        if (!metadata.taxonomy[key]) {
          console.warn(
            `warn: taxonomy config key '${key}' does not match any chunk metadata — this configuration has no effect`,
          );
        }
      }

      // Close previous index before writing the new one
      previousIndex?.close();

      const indexStepLabels: Record<IndexBuildStep, string> = {
        "writing-table": "Building search index: writing table...",
        "indexing-fts": "Building search index: full-text index...",
        "indexing-scalar": "Building search index: scalar indices...",
        "indexing-vector": "Building search index: vector index...",
      };
      const buildInput: {
        dbPath: string;
        chunks: Chunk[];
        metadataKeys: string[];
        vectorsByChunkId?: Map<string, number[]>;
        fileFingerprints?: Record<string, string>;
        onProgress?: (step: IndexBuildStep) => void;
      } = {
        dbPath: lanceDbTmpPath,
        chunks,
        metadataKeys,
        fileFingerprints: newFileFingerprints,
        onProgress: (step) => writeProgress(indexStepLabels[step]),
      };
      if (vectorsByChunkId) {
        buildInput.vectorsByChunkId = vectorsByChunkId;
      }
      await buildLanceDbIndex(buildInput);
      clearProgress();

      await writeFile(path.join(outDir, "chunks.json"), JSON.stringify(chunks, null, 2));
      await writeFile(
        path.join(outDir, "metadata.json"),
        JSON.stringify(
          {
            ...metadata,
            index: {
              engine: "lancedb",
              table: "chunks",
              path: ".lancedb",
            },
          },
          null,
          2,
        ),
      );

      // Atomic swap: .lancedb.tmp → .lancedb
      await rm(lanceDbOldPath, { recursive: true, force: true });
      try {
        await rename(lanceDbPath, lanceDbOldPath);
      } catch {}
      await rename(lanceDbTmpPath, lanceDbPath);
      await rm(lanceDbOldPath, { recursive: true, force: true }).catch(() => {});

      console.log(`wrote ${chunks.length} chunks and .lancedb index to ${outDir}`);
    },
  );

program
  .command("fix")
  .description("Generate a baseline .docs-mcp.json using deterministic heading heuristics")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .action(async (options: { docsDir: string }) => {
    const docsDir = path.resolve(options.docsDir);
    const manifestPath = path.join(docsDir, ".docs-mcp.json");

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
          markdown,
        };
      }),
    );
    const baseline: Manifest = buildHeuristicManifest(manifestInput);

    await writeFile(manifestPath, `${JSON.stringify(baseline, null, 2)}\n`);
    const overrideCount = baseline.overrides?.length ?? 0;
    console.log(
      `created ${manifestPath} (default=${baseline.strategy?.chunk_by ?? "h2"}, overrides=${overrideCount})`,
    );
  });

void program.parseAsync(process.argv);

async function loadNearestManifest(
  filePath: string,
  docsDir: string,
  cache: Map<string, Manifest>,
): Promise<{ manifest: Manifest; manifestBaseDir: string } | undefined> {
  let currentDir = path.dirname(filePath);
  const stopDir = path.resolve(docsDir);

  while (true) {
    const candidate = path.join(currentDir, ".docs-mcp.json");
    if (await exists(candidate)) {
      const cached = cache.get(candidate);
      const manifest = cached ?? parseManifestJson(await readFile(candidate, "utf8"));
      if (!cached) {
        cache.set(candidate, manifest);
      }
      const relativeDir = toPosix(path.relative(stopDir, currentDir));
      return {
        manifest,
        manifestBaseDir: relativeDir || ".",
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
    dot: false,
  });
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function buildMetadata(
  chunks: Chunk[],
  files: string[],
  corpusDescription: string,
  embedding: EmbeddingMetadata | null,
  sourceCommit: string | null,
  taxonomyConfig: Record<string, ManifestTaxonomyFieldConfig>,
  toolDescriptions?: Record<string, string>,
): {
  metadata_version: string;
  corpus_description: string;
  taxonomy: Record<
    string,
    {
      description: string;
      values: string[];
      vector_collapse?: boolean;
      properties?: Record<string, { mcp_resource: boolean }>;
    }
  >;
  stats: {
    total_chunks: number;
    total_files: number;
    indexed_at: string;
    source_commit: string | null;
  };
  embedding: EmbeddingMetadata | null;
  tool_descriptions?: Record<string, string>;
} {
  const taxonomyValues = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const [key, value] of Object.entries(chunk.metadata)) {
      const values = taxonomyValues.get(key) ?? new Set<string>();
      values.add(value);
      taxonomyValues.set(key, values);
    }
  }

  const taxonomy: Record<
    string,
    {
      description: string;
      values: string[];
      vector_collapse?: boolean;
      properties?: Record<string, { mcp_resource: boolean }>;
    }
  > = {};
  for (const [key, values] of taxonomyValues.entries()) {
    const config = taxonomyConfig[key];
    taxonomy[key] = {
      description: `Filter results by ${key}.`,
      values: [...values].sort((a, b) => a.localeCompare(b)),
      ...(config?.vector_collapse ? { vector_collapse: true } : {}),
      ...(config?.properties ? { properties: config.properties } : {}),
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
      source_commit: sourceCommit,
    },
    embedding,
    ...(toolDescriptions ? { tool_descriptions: toolDescriptions } : {}),
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

  throw new Error(`unsupported embedding provider '${value}'. Expected one of: none, hash, openai`);
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
