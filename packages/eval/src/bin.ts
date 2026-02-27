#!/usr/bin/env node

import "dotenv/config";

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ensureIndex } from "./agent/build-cache.js";
import { loadPreviousResult, saveResult, generateTrendSummary } from "./agent/history.js";
import { ConsoleObserver, NoopObserver } from "./agent/observer.js";
import { ensureRepo } from "./agent/repo-cache.js";
import { runAgentEval } from "./agent/runner.js";
import type { AgentScenario } from "./agent/types.js";
import { generateBenchmarkMarkdown, parseEmbeddingSpec, runBenchmark } from "./benchmark.js";
import { generateDeltaMarkdown, toDeltaCases } from "./delta.js";
import { runEvaluationAgainstServer, type EvalHarnessOutput, type EvalQueryCase } from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVAL_PKG_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(EVAL_PKG_ROOT, "fixtures", "agent-scenarios");
const CLI_BIN_PATH = path.resolve(EVAL_PKG_ROOT, "..", "cli", "dist", "index.js");
const SERVER_BIN_PATH = path.resolve(EVAL_PKG_ROOT, "..", "server", "dist", "bin.js");

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

program
  .command("benchmark")
  .description("Run eval cases across multiple embedding models and produce a comparison report")
  .requiredOption("--cases <path>", "Path to eval cases JSON")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .requiredOption("--work-dir <path>", "Working directory for per-provider outputs")
  .requiredOption("--build-command <path>", "Path to CLI build script")
  .requiredOption("--server-command <path>", "Path to server script")
  .option("--embeddings <list>", "Comma-separated embedding specs: none,hash,openai/text-embedding-3-large", "none,openai/text-embedding-3-large")
  .option("--warmup-queries <n>", "Warmup queries per provider", parseIntOption, 3)
  .option("--out <path>", "Output JSON path (else stdout)")
  .action(async (options: {
    cases: string;
    docsDir: string;
    workDir: string;
    buildCommand: string;
    serverCommand: string;
    embeddings: string;
    warmupQueries: number;
    out?: string;
  }) => {
    const embeddings = options.embeddings.split(",").map((s) => parseEmbeddingSpec(s)).filter((s) => s.provider);

    const casesPath = path.resolve(options.cases);
    const casesRaw = await readFile(casesPath, "utf8");
    const cases = JSON.parse(casesRaw) as EvalQueryCase[];

    const result = await runBenchmark({
      docsDir: path.resolve(options.docsDir),
      casesPath,
      workDir: path.resolve(options.workDir),
      buildCommand: path.resolve(options.buildCommand),
      serverCommand: path.resolve(options.serverCommand),
      embeddings,
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

program
  .command("agent-eval")
  .description("Run agent-based eval scenarios against a docs-mcp server")
  .option("--suite <name>", "Named scenario suite (resolves to fixtures/agent-scenarios/<name>.json)")
  .option("--scenarios <path>", "Path to JSON array of agent scenarios")
  .option("--prompt <text>", "Ad-hoc single scenario prompt (requires --docs-dir)")
  .option("--include <ids>", "Comma-separated scenario IDs to run (filters loaded scenarios)")
  .option("--docs-dir <path>", "Default docs directory for scenarios that don't specify their own")
  .option("--server-command <value>", "Command to launch the MCP server (auto-resolved when using docsDir)")
  .option("--server-arg <value>", "Server arg (repeatable)", collectValues, [] as string[])
  .option("--server-cwd <path>", "Working directory for server process")
  .option("--server-env <key=value>", "Server environment variable (repeatable)", collectKeyValues, {} as Record<string, string>)
  .option("--workspace-dir <path>", "Base directory for agent workspaces")
  .option("--model <value>", "Claude model to use", "claude-sonnet-4-20250514")
  .option("--max-turns <number>", "Default max turns per scenario", parseIntOption, 15)
  .option("--max-budget-usd <number>", "Default max budget per scenario in USD", parseFloatOption, 0.50)
  .option("--max-concurrency <number>", "Max concurrent scenarios", parseIntOption, 1)
  .option("--system-prompt <value>", "Custom system prompt for the agent")
  .option("--debug", "Keep workspaces after run for inspection", false)
  .option("--no-save", "Skip auto-saving results to .eval-results/")
  .option("--out <path>", "Output JSON path")
  .action(async (options: {
    suite?: string;
    scenarios?: string;
    prompt?: string;
    include?: string;
    docsDir?: string;
    serverCommand?: string;
    serverArg: string[];
    serverCwd?: string;
    serverEnv: Record<string, string>;
    workspaceDir?: string;
    model: string;
    maxTurns: number;
    maxBudgetUsd: number;
    maxConcurrency: number;
    systemPrompt?: string;
    debug: boolean;
    save: boolean;
    out?: string;
  }) => {
    // Validate mutually exclusive options
    const sourceCount = [options.suite, options.scenarios, options.prompt].filter(Boolean).length;
    if (sourceCount === 0) {
      console.error("Error: one of --suite, --scenarios, or --prompt is required");
      process.exit(1);
    }
    if (sourceCount > 1) {
      console.error("Error: --suite, --scenarios, and --prompt are mutually exclusive");
      process.exit(1);
    }
    if (options.prompt && !options.docsDir) {
      console.error("Error: --prompt requires --docs-dir");
      process.exit(1);
    }

    // Load scenarios
    let { scenarios, scenariosFilePath } = await loadScenarios(options);

    // Filter by --include
    if (options.include) {
      const includeIds = new Set(options.include.split(",").map((s) => s.trim()));
      scenarios = scenarios.filter((s) => includeIds.has(s.id));
      if (scenarios.length === 0) {
        console.error(`Error: no scenarios matched --include "${options.include}"`);
        process.exit(1);
      }
    }

    // Resolve docsDir → build indexes → set indexDir on each scenario
    const defaultDocsDir = options.docsDir ? path.resolve(options.docsDir) : undefined;
    const indexCache = new Map<string, string>(); // dedup builds for shared docsDirs
    const indexDescriptions = new Map<string, string>(); // first description per docsDir

    for (const scenario of scenarios) {
      let resolvedDocsDir: string | undefined;
      if (scenario.docsSpec) {
        resolvedDocsDir = await ensureRepo(scenario.docsSpec);
      } else if (scenario.docsDir) {
        const base = scenariosFilePath ? path.dirname(scenariosFilePath) : process.cwd();
        resolvedDocsDir = path.resolve(base, scenario.docsDir);
      } else if (defaultDocsDir) {
        resolvedDocsDir = defaultDocsDir;
      }

      if (resolvedDocsDir) {
        // Use scenario description for the corpus; first one wins per docsDir
        const description = scenario.description ?? indexDescriptions.get(resolvedDocsDir);
        if (scenario.description && !indexDescriptions.has(resolvedDocsDir)) {
          indexDescriptions.set(resolvedDocsDir, scenario.description);
        }

        const cacheKey = `${resolvedDocsDir}\0${description ?? ""}`;
        let indexDir = indexCache.get(cacheKey);
        if (!indexDir) {
          indexDir = await ensureIndex(resolvedDocsDir, CLI_BIN_PATH, undefined, description);
          indexCache.set(cacheKey, indexDir);
        }
        scenario.indexDir = indexDir;
      }
    }

    // Server config: only needed when some scenarios don't have indexDir
    const allHaveIndex = scenarios.every((s) => s.indexDir);
    if (!allHaveIndex && !options.serverCommand) {
      console.error("Error: --server-command is required when scenarios don't specify docsDir");
      process.exit(1);
    }

    const server = options.serverCommand
      ? {
          command: options.serverCommand,
          args: options.serverArg,
          ...(options.serverCwd ? { cwd: path.resolve(options.serverCwd) } : {}),
          ...(Object.keys(options.serverEnv).length > 0 ? { env: options.serverEnv } : {})
        }
      : undefined;

    const suiteName = options.suite
      ?? (options.scenarios ? path.basename(options.scenarios, path.extname(options.scenarios)) : "ad-hoc");

    const observer = new ConsoleObserver({
      model: options.model,
      suite: suiteName,
      debug: options.debug
    });

    const output = await runAgentEval({
      scenarios,
      ...(server ? { server } : {}),
      ...(options.workspaceDir ? { workspaceDir: path.resolve(options.workspaceDir) } : {}),
      model: options.model,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      maxConcurrency: options.maxConcurrency,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      observer,
      debug: options.debug
    });

    // Auto-persist + trend comparison
    if (options.save !== false) {
      const previous = await loadPreviousResult(suiteName);
      const savedPath = await saveResult(output, suiteName);
      process.stderr.write(`\nResults saved to ${savedPath}\n`);

      if (previous) {
        const trend = generateTrendSummary(output, previous);
        process.stderr.write(`${trend}\n`);
      }
    }

    // Write JSON only when explicitly requested via --out
    if (options.out) {
      const serialized = `${JSON.stringify(output, null, 2)}\n`;
      const outPath = path.resolve(options.out);
      await writeFile(outPath, serialized);
      process.stderr.write(`Wrote agent eval result to ${outPath}\n`);
    }
  });

void program.parseAsync(process.argv);

async function loadScenarios(options: {
  suite?: string;
  scenarios?: string;
  prompt?: string;
  docsDir?: string;
}): Promise<{ scenarios: AgentScenario[]; scenariosFilePath?: string }> {
  if (options.suite) {
    const filePath = path.join(FIXTURES_DIR, `${options.suite}.json`);
    const raw = await readFile(filePath, "utf8");
    return { scenarios: parseScenarioFile(raw), scenariosFilePath: filePath };
  }
  if (options.scenarios) {
    const filePath = path.resolve(options.scenarios);
    const raw = await readFile(filePath, "utf8");
    return { scenarios: parseScenarioFile(raw), scenariosFilePath: filePath };
  }
  // --prompt mode
  return {
    scenarios: [{
      id: "ad-hoc",
      name: "ad-hoc",
      prompt: options.prompt!,
      assertions: [],
      docsDir: options.docsDir!
    }]
  };
}

function parseScenarioFile(raw: string): AgentScenario[] {
  const parsed = JSON.parse(raw);

  // Legacy array format — auto-generate ids from names
  if (Array.isArray(parsed)) {
    return (parsed as AgentScenario[]).map((s) => ({
      ...s,
      id: s.id ?? slugify(s.name)
    }));
  }

  // K:V format — key is the scenario id
  return Object.entries(parsed as Record<string, Omit<AgentScenario, "id">>).map(
    ([id, scenario]) => ({ ...scenario, id })
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectKeyValues(value: string, previous: Record<string, string>): Record<string, string> {
  const eqIdx = value.indexOf("=");
  if (eqIdx < 0) {
    throw new Error(`expected key=value format, got '${value}'`);
  }
  return { ...previous, [value.slice(0, eqIdx)]: value.slice(eqIdx + 1) };
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, got '${value}'`);
  }
  return parsed;
}

function parseFloatOption(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative number, got '${value}'`);
  }
  return parsed;
}
