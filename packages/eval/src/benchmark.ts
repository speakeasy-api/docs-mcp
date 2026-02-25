import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CategoryBreakdown } from "./metrics.js";
import { computeCategoryBreakdown } from "./metrics.js";
import { runEvaluationAgainstServer, type EvalHarnessOutput, type EvalQueryCase } from "./runner.js";

export type ProviderName = "none" | "hash" | "openai";

export interface BenchmarkConfig {
  docsDir: string;
  casesPath: string;
  workDir: string;
  buildCommand: string;
  serverCommand: string;
  providers: ProviderName[];
  warmupQueries: number;
}

export interface BenchmarkProviderResult {
  provider: ProviderName;
  output: EvalHarnessOutput;
  categoryBreakdown: CategoryBreakdown[];
  corpusSizeBytes: number;
  indexSizeBytes: number;
  indexSizeMultiple: number;
}

export interface BenchmarkResult {
  providers: BenchmarkProviderResult[];
}

export async function runBenchmark(
  config: BenchmarkConfig,
  cases: EvalQueryCase[]
): Promise<BenchmarkResult> {
  const providers: BenchmarkProviderResult[] = [];

  for (const provider of config.providers) {
    if (provider === "openai" && !process.env.OPENAI_API_KEY) {
      console.error(`Skipping provider "openai": OPENAI_API_KEY not set`);
      continue;
    }

    console.error(`\n--- Running benchmark for provider: ${provider} ---`);

    try {
      const outDir = path.join(config.workDir, provider);

      const buildArgs = [
        "build",
        "--docs-dir", config.docsDir,
        "--out", outDir,
        "--embedding-provider", provider
      ];

      const queryEmbeddingProvider = provider === "none" ? "none" : "auto";
      const serverArgs = [
        "--index-dir", outDir,
        "--query-embedding-provider", queryEmbeddingProvider
      ];

      const output = await runEvaluationAgainstServer({
        server: {
          command: "node",
          args: [config.serverCommand, ...serverArgs]
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

      providers.push({
        provider,
        output,
        categoryBreakdown,
        corpusSizeBytes,
        indexSizeBytes,
        indexSizeMultiple
      });

      console.error(`Provider "${provider}" complete`);
    } catch (err) {
      console.error(`Provider "${provider}" failed:`, err);
    }
  }

  return { providers };
}

export function generateBenchmarkMarkdown(result: BenchmarkResult): string {
  if (result.providers.length === 0) {
    return "No benchmark results available.";
  }

  const providerNames = result.providers.map((p) => p.provider);
  const lines: string[] = [];

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | ${providerNames.join(" | ")} |`);
  lines.push(`| --- | ${providerNames.map(() => "---:").join(" | ")} |`);

  const summaryRows: Array<{ label: string; values: string[] }> = [
    { label: "MRR@5", values: result.providers.map((p) => p.output.summary.mrrAt5.toFixed(4)) },
    { label: "NDCG@5", values: result.providers.map((p) => p.output.summary.ndcgAt5.toFixed(4)) },
    { label: "Facet Precision", values: result.providers.map((p) => p.output.summary.facetPrecision.toFixed(4)) },
    { label: "Search p50 (ms)", values: result.providers.map((p) => p.output.summary.searchP50Ms.toFixed(1)) },
    { label: "Search p95 (ms)", values: result.providers.map((p) => p.output.summary.searchP95Ms.toFixed(1)) },
    { label: "Build Time (ms)", values: result.providers.map((p) => p.output.summary.buildTimeMs.toFixed(0)) },
    { label: "Peak RSS (MB)", values: result.providers.map((p) => p.output.summary.peakRssMb.toFixed(1)) },
    { label: "Index Size (x corpus)", values: result.providers.map((p) => `${p.indexSizeMultiple.toFixed(1)}x`) }
  ];

  for (const row of summaryRows) {
    lines.push(`| ${row.label} | ${row.values.join(" | ")} |`);
  }

  // Collect all categories across providers
  const allCategories = new Set<string>();
  for (const p of result.providers) {
    for (const cb of p.categoryBreakdown) {
      allCategories.add(cb.category);
    }
  }
  const sortedCategories = [...allCategories].sort();

  if (sortedCategories.length > 0) {
    // Per-Category Facet Precision
    lines.push("");
    lines.push("## Per-Category Facet Precision");
    lines.push("");
    lines.push(`| Category | ${providerNames.join(" | ")} |`);
    lines.push(`| --- | ${providerNames.map(() => "---:").join(" | ")} |`);

    for (const cat of sortedCategories) {
      const values = result.providers.map((p) => {
        const cb = p.categoryBreakdown.find((c) => c.category === cat);
        return cb ? cb.facetPrecision.toFixed(4) : "-";
      });
      lines.push(`| ${cat} | ${values.join(" | ")} |`);
    }

    // Per-Category MRR@5
    lines.push("");
    lines.push("## Per-Category MRR@5");
    lines.push("");
    lines.push(`| Category | ${providerNames.join(" | ")} |`);
    lines.push(`| --- | ${providerNames.map(() => "---:").join(" | ")} |`);

    for (const cat of sortedCategories) {
      const values = result.providers.map((p) => {
        const cb = p.categoryBreakdown.find((c) => c.category === cat);
        return cb ? cb.mrrAt5.toFixed(4) : "-";
      });
      lines.push(`| ${cat} | ${values.join(" | ")} |`);
    }
  }

  return lines.join("\n");
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
