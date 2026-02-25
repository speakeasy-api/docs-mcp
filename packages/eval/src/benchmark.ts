import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createEmbeddingProvider } from "@speakeasy-api/docs-mcp-core";
import type { CategoryBreakdown } from "./metrics.js";
import { computeCategoryBreakdown } from "./metrics.js";
import { runEvaluationAgainstServer, type EvalHarnessOutput, type EvalQueryCase } from "./runner.js";

/**
 * An embedding spec parsed from CLI input like "none", "hash", or "openai/text-embedding-3-large".
 */
export interface EmbeddingSpec {
  provider: string;
  model?: string;
  /** Display label used in report columns (e.g. "openai/text-embedding-3-large") */
  label: string;
}

export function parseEmbeddingSpec(raw: string): EmbeddingSpec {
  const trimmed = raw.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx < 0) {
    return { provider: trimmed, label: trimmed };
  }
  const provider = trimmed.slice(0, slashIdx);
  const model = trimmed.slice(slashIdx + 1);
  return { provider, model, label: trimmed };
}

export interface BenchmarkConfig {
  docsDir: string;
  casesPath: string;
  workDir: string;
  buildCommand: string;
  serverCommand: string;
  embeddings: EmbeddingSpec[];
  warmupQueries: number;
}

export interface BenchmarkEmbeddingResult {
  embedding: EmbeddingSpec;
  output: EvalHarnessOutput;
  categoryBreakdown: CategoryBreakdown[];
  corpusSizeBytes: number;
  indexSizeBytes: number;
  indexSizeMultiple: number;
  costPerMillionTokens: number;
}

export interface BenchmarkResult {
  embeddings: BenchmarkEmbeddingResult[];
}

function resolveCostPerMillionTokens(spec: EmbeddingSpec): number {
  try {
    const provider = createEmbeddingProvider({
      provider: spec.provider as "none" | "hash" | "openai",
      // Provide a dummy key so we can instantiate the provider to read its cost
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.provider === "openai" ? { apiKey: "dummy" } : {})
    });
    return provider.costPerMillionTokens;
  } catch {
    return 0;
  }
}

/** Rough chars-per-token ratio for English text. */
const CHARS_PER_TOKEN = 4;

export async function runBenchmark(
  config: BenchmarkConfig,
  cases: EvalQueryCase[]
): Promise<BenchmarkResult> {
  const embeddings: BenchmarkEmbeddingResult[] = [];

  for (const embedding of config.embeddings) {
    if (embedding.provider === "openai" && !process.env.OPENAI_API_KEY) {
      console.error(`Skipping "${embedding.label}": OPENAI_API_KEY not set`);
      continue;
    }

    console.error(`\n--- Running benchmark: ${embedding.label} ---`);

    try {
      const outDir = path.join(config.workDir, embedding.label);

      const buildArgs = [
        "build",
        "--docs-dir", config.docsDir,
        "--out", outDir,
        "--embedding-provider", embedding.provider,
        ...(embedding.model ? ["--embedding-model", embedding.model] : [])
      ];

      const serverArgs = [
        "--index-dir", outDir
      ];

      // StdioClientTransport only inherits a small allowlist of env vars
      // (HOME, PATH, SHELL, etc.), so we must pass process.env explicitly
      // for the server to receive OPENAI_API_KEY and similar.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) {
          env[k] = v;
        }
      }

      const output = await runEvaluationAgainstServer({
        server: {
          command: "node",
          args: [config.serverCommand, ...serverArgs],
          env
        },
        build: {
          command: "node",
          args: [config.buildCommand, ...buildArgs]
        },
        cases,
        warmupQueries: config.warmupQueries,
        deterministic: true
      });

      const categoryBreakdown = computeCategoryBreakdown(output.rankedCases);
      const corpusSizeBytes = await measureDirSize(config.docsDir, [".md"]);
      const indexSizeBytes = await measureDirSize(outDir);
      const indexSizeMultiple = corpusSizeBytes > 0 ? indexSizeBytes / corpusSizeBytes : 0;
      const costPerMillionTokens = resolveCostPerMillionTokens(embedding);

      embeddings.push({
        embedding,
        output,
        categoryBreakdown,
        corpusSizeBytes,
        indexSizeBytes,
        indexSizeMultiple,
        costPerMillionTokens
      });

      console.error(`"${embedding.label}" complete`);
    } catch (err) {
      console.error(`"${embedding.label}" failed:`, err);
    }
  }

  return { embeddings };
}

export function generateBenchmarkMarkdown(result: BenchmarkResult): string {
  if (result.embeddings.length === 0) {
    return "No benchmark results available.";
  }

  const labels = result.embeddings.map((e) => e.embedding.label);
  const lines: string[] = [];

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | ${labels.join(" | ")} |`);
  lines.push(`| --- | ${labels.map(() => "---:").join(" | ")} |`);

  const summaryRows: Array<{ label: string; values: string[] }> = [
    { label: "MRR@5", values: result.embeddings.map((e) => e.output.summary.mrrAt5.toFixed(4)) },
    { label: "NDCG@5", values: result.embeddings.map((e) => e.output.summary.ndcgAt5.toFixed(4)) },
    { label: "Facet Precision", values: result.embeddings.map((e) => e.output.summary.facetPrecision.toFixed(4)) },
    { label: "Search p50 (ms)", values: result.embeddings.map((e) => e.output.summary.searchP50Ms.toFixed(1)) },
    { label: "Search p95 (ms)", values: result.embeddings.map((e) => e.output.summary.searchP95Ms.toFixed(1)) },
    { label: "Build Time (ms)", values: result.embeddings.map((e) => e.output.summary.buildTimeMs.toFixed(0)) },
    { label: "Peak RSS (MB)", values: result.embeddings.map((e) => e.output.summary.peakRssMb.toFixed(1)) },
    { label: `Index Size (corpus ${formatMb(result.embeddings[0]?.corpusSizeBytes ?? 0)})`, values: result.embeddings.map((e) => formatMb(e.indexSizeBytes)) },
    { label: "Embed Cost (est.)", values: result.embeddings.map((e) => {
      if (e.costPerMillionTokens === 0) return "$0";
      const estimatedTokens = e.corpusSizeBytes / CHARS_PER_TOKEN;
      const cost = (estimatedTokens / 1_000_000) * e.costPerMillionTokens;
      return `$${cost.toFixed(4)}`;
    }) },
    { label: "Query Cost (est.)", values: result.embeddings.map((e) => {
      if (e.costPerMillionTokens === 0) return "$0";
      // ~20 tokens per query
      const cost = (20 / 1_000_000) * e.costPerMillionTokens;
      return `$${cost.toFixed(6)}`;
    }) }
  ];

  for (const row of summaryRows) {
    lines.push(`| ${row.label} | ${row.values.join(" | ")} |`);
  }

  // Collect all categories across embeddings
  const allCategories = new Set<string>();
  for (const e of result.embeddings) {
    for (const cb of e.categoryBreakdown) {
      allCategories.add(cb.category);
    }
  }
  const sortedCategories = [...allCategories].sort();

  if (sortedCategories.length > 0) {
    // Per-Category Facet Precision
    lines.push("");
    lines.push("## Per-Category Facet Precision");
    lines.push("");
    lines.push(`| Category | ${labels.join(" | ")} |`);
    lines.push(`| --- | ${labels.map(() => "---:").join(" | ")} |`);

    for (const cat of sortedCategories) {
      const values = result.embeddings.map((e) => {
        const cb = e.categoryBreakdown.find((c) => c.category === cat);
        return cb ? cb.facetPrecision.toFixed(4) : "-";
      });
      lines.push(`| ${cat} | ${values.join(" | ")} |`);
    }

    // Per-Category MRR@5
    lines.push("");
    lines.push("## Per-Category MRR@5");
    lines.push("");
    lines.push(`| Category | ${labels.join(" | ")} |`);
    lines.push(`| --- | ${labels.map(() => "---:").join(" | ")} |`);

    for (const cat of sortedCategories) {
      const values = result.embeddings.map((e) => {
        const cb = e.categoryBreakdown.find((c) => c.category === cat);
        return cb ? cb.mrrAt5.toFixed(4) : "-";
      });
      lines.push(`| ${cat} | ${values.join(" | ")} |`);
    }
  }

  return lines.join("\n");
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)}KB`;
}

async function measureDirSize(dir: string, extensions?: string[]): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { recursive: true });
    for (const entry of entries) {
      if (extensions && !extensions.some((ext) => entry.endsWith(ext))) {
        continue;
      }
      try {
        const s = await stat(path.join(dir, entry));
        if (s.isFile()) {
          total += s.size;
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return total;
}
