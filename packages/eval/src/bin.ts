#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { generateBenchmarkMarkdown, runBenchmark, type ProviderName } from "./benchmark.js";
import { generateDeltaMarkdown, toDeltaCases } from "./delta.js";
import { runEvaluationAgainstServer, type EvalHarnessOutput, type EvalQueryCase } from "./runner.js";

const program = new Command();

program
  .name("docs-mcp-eval")
  .description("Run MCP docs eval suite against an MCP server over stdio");

program
  .command("run", { isDefault: true })
  .description("Run eval cases against a single server")
  .requiredOption("--cases <path>", "Path to JSON array of eval cases")
  .requiredOption("--server-command <value>", "Command to launch the MCP server")
  .option("--server-arg <value>", "Server arg (repeatable)", collectValues, [] as string[])
  .option("--server-cwd <path>", "Working directory for server process")
  .option("--build-command <value>", "Optional command to run index build benchmark before eval")
  .option("--build-arg <value>", "Build arg (repeatable)", collectValues, [] as string[])
  .option("--build-cwd <path>", "Working directory for build command")
  .option("--warmup-queries <number>", "Number of warmup search_docs calls", parseIntOption, 0)
  .option("--baseline <path>", "Optional baseline eval JSON for delta markdown")
  .option("--out <path>", "Optional output JSON path")
  .action(async (options: {
    cases: string;
    serverCommand: string;
    serverArg: string[];
    serverCwd?: string;
    buildCommand?: string;
    buildArg: string[];
    buildCwd?: string;
    warmupQueries: number;
    baseline?: string;
    out?: string;
  }) => {
    const casesPath = path.resolve(options.cases);
    const casesRaw = await readFile(casesPath, "utf8");
    const cases = JSON.parse(casesRaw) as EvalQueryCase[];

    const server = {
      command: options.serverCommand,
      args: options.serverArg,
      ...(options.serverCwd ? { cwd: path.resolve(options.serverCwd) } : {})
    };
    const build = options.buildCommand
      ? {
          command: options.buildCommand,
          args: options.buildArg,
          ...(options.buildCwd ? { cwd: path.resolve(options.buildCwd) } : {})
        }
      : undefined;

    const result = await runEvaluationAgainstServer({
      server,
      ...(build ? { build } : {}),
      cases,
      warmupQueries: options.warmupQueries,
      deterministic: true
    });

    let deltaMarkdown: string | undefined;
    if (options.baseline) {
      const baselinePath = path.resolve(options.baseline);
      const baselineRaw = await readFile(baselinePath, "utf8");
      const baseline = JSON.parse(baselineRaw) as EvalHarnessOutput;
      deltaMarkdown = generateDeltaMarkdown(
        { summary: result.summary, cases: toDeltaCases(result.rankedCases) },
        { summary: baseline.summary, cases: toDeltaCases(baseline.rankedCases) }
      );
    }

    const payload = {
      ...result,
      deltaMarkdown
    };

    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    if (options.out) {
      const outPath = path.resolve(options.out);
      await writeFile(outPath, serialized);
      console.log(`wrote eval result to ${outPath}`);
    } else {
      process.stdout.write(serialized);
    }

    if (deltaMarkdown) {
      process.stderr.write(`${deltaMarkdown}\n`);
    }
  });

const ALL_PROVIDERS: ProviderName[] = ["none", "hash", "openai"];

program
  .command("benchmark")
  .description("Run eval cases across multiple embedding providers and produce a comparison report")
  .requiredOption("--cases <path>", "Path to eval cases JSON")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .requiredOption("--work-dir <path>", "Working directory for per-provider outputs")
  .requiredOption("--build-command <path>", "Path to CLI build script")
  .requiredOption("--server-command <path>", "Path to server script")
  .option("--providers <list>", "Comma-separated: none,hash,openai", "none,hash,openai")
  .option("--warmup-queries <n>", "Warmup queries per provider", parseIntOption, 3)
  .option("--out <path>", "Output JSON path (else stdout)")
  .action(async (options: {
    cases: string;
    docsDir: string;
    workDir: string;
    buildCommand: string;
    serverCommand: string;
    providers: string;
    warmupQueries: number;
    out?: string;
  }) => {
    const providers = options.providers.split(",").map((s) => s.trim()).filter(Boolean) as ProviderName[];
    for (const p of providers) {
      if (!ALL_PROVIDERS.includes(p)) {
        console.error(`Unknown provider: ${p}. Must be one of: ${ALL_PROVIDERS.join(", ")}`);
        process.exit(1);
      }
    }

    const casesPath = path.resolve(options.cases);
    const casesRaw = await readFile(casesPath, "utf8");
    const cases = JSON.parse(casesRaw) as EvalQueryCase[];

    const result = await runBenchmark({
      docsDir: path.resolve(options.docsDir),
      casesPath,
      workDir: path.resolve(options.workDir),
      buildCommand: path.resolve(options.buildCommand),
      serverCommand: path.resolve(options.serverCommand),
      providers,
      warmupQueries: options.warmupQueries
    }, cases);

    const markdown = generateBenchmarkMarkdown(result);

    if (options.out) {
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const outPath = path.resolve(options.out);
      await writeFile(outPath, serialized);
      console.error(`wrote benchmark result to ${outPath}`);
    }

    process.stdout.write(`\n${markdown}\n`);
  });

void program.parseAsync(process.argv);

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, got '${value}'`);
  }
  return parsed;
}
