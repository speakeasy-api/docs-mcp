#!/usr/bin/env node

import "dotenv/config";

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import YAML from "yaml";
import { ensureIndex } from "./agent/build-cache.js";
import { buildComparison, formatComparisonReport } from "./agent/comparison.js";
import { loadPreviousResult, saveResult, generateTrendSummary } from "./agent/history.js";
import { ConsoleObserver } from "./agent/observer.js";
import { ensureRepo } from "./agent/repo-cache.js";
import { defaultModelForProvider, resolveAgentProvider } from "./agent/provider.js";
import { runAgentEval } from "./agent/runner.js";
import type { AgentEvalConfig, AgentScenario, FeedbackToolConfig } from "./agent/types.js";
import { generateBenchmarkMarkdown, parseEmbeddingSpec, runBenchmark } from "./benchmark.js";
import { generateDeltaMarkdown, toDeltaCases } from "./delta.js";
import {
  runEvaluationAgainstServer,
  type EvalHarnessOutput,
  type EvalQueryCase,
} from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVAL_PKG_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(EVAL_PKG_ROOT, "fixtures", "agent-scenarios");
const CLI_BIN_PATH = path.resolve(EVAL_PKG_ROOT, "..", "cli", "dist", "index.js");

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
  .action(
    async (options: {
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
        ...(options.serverCwd ? { cwd: path.resolve(options.serverCwd) } : {}),
      };
      const build = options.buildCommand
        ? {
            command: options.buildCommand,
            args: options.buildArg,
            ...(options.buildCwd ? { cwd: path.resolve(options.buildCwd) } : {}),
          }
        : undefined;

      const result = await runEvaluationAgainstServer({
        server,
        ...(build ? { build } : {}),
        cases,
        warmupQueries: options.warmupQueries,
        deterministic: true,
      });

      let deltaMarkdown: string | undefined;
      if (options.baseline) {
        const baselinePath = path.resolve(options.baseline);
        const baselineRaw = await readFile(baselinePath, "utf8");
        const baseline = JSON.parse(baselineRaw) as EvalHarnessOutput;
        deltaMarkdown = generateDeltaMarkdown(
          { summary: result.summary, cases: toDeltaCases(result.rankedCases) },
          {
            summary: baseline.summary,
            cases: toDeltaCases(baseline.rankedCases),
          },
        );
      }

      const payload = {
        ...result,
        deltaMarkdown,
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
    },
  );

program
  .command("benchmark")
  .description("Run eval cases across multiple embedding models and produce a comparison report")
  .requiredOption("--cases <path>", "Path to eval cases JSON")
  .requiredOption("--docs-dir <path>", "Path to markdown corpus")
  .requiredOption("--work-dir <path>", "Working directory for per-provider outputs")
  .requiredOption("--build-command <path>", "Path to CLI build script")
  .requiredOption("--server-command <path>", "Path to server script")
  .option(
    "--embeddings <list>",
    "Comma-separated embedding specs: none,hash,openai/text-embedding-3-large",
    "none,openai/text-embedding-3-large",
  )
  .option("--warmup-queries <n>", "Warmup queries per provider", parseIntOption, 3)
  .option("--out <path>", "Output JSON path (else stdout)")
  .action(
    async (options: {
      cases: string;
      docsDir: string;
      workDir: string;
      buildCommand: string;
      serverCommand: string;
      embeddings: string;
      warmupQueries: number;
      out?: string;
    }) => {
      const embeddings = options.embeddings
        .split(",")
        .map((s) => parseEmbeddingSpec(s))
        .filter((s) => s.provider);

      const casesPath = path.resolve(options.cases);
      const casesRaw = await readFile(casesPath, "utf8");
      const cases = JSON.parse(casesRaw) as EvalQueryCase[];

      const result = await runBenchmark(
        {
          docsDir: path.resolve(options.docsDir),
          casesPath,
          workDir: path.resolve(options.workDir),
          buildCommand: path.resolve(options.buildCommand),
          serverCommand: path.resolve(options.serverCommand),
          embeddings,
          warmupQueries: options.warmupQueries,
        },
        cases,
      );

      const markdown = generateBenchmarkMarkdown(result);

      if (options.out) {
        const serialized = `${JSON.stringify(result, null, 2)}\n`;
        const outPath = path.resolve(options.out);
        await writeFile(outPath, serialized);
        console.error(`wrote benchmark result to ${outPath}`);
      }

      process.stdout.write(`\n${markdown}\n`);
    },
  );

program
  .command("agent-eval")
  .description("Run agent-based eval scenarios against a docs-mcp server")
  .option(
    "--suite <name>",
    "Named scenario suite (resolves to fixtures/agent-scenarios/<name>.yaml)",
  )
  .option("--scenarios <path>", "Path to YAML/JSON scenario file")
  .option("--prompt <text>", "Ad-hoc single scenario prompt (requires --docs-dir)")
  .option("--include <ids>", "Comma-separated scenario IDs to run (filters loaded scenarios)")
  .option("--docs-dir <path>", "Default docs directory for scenarios that don't specify their own")
  .option(
    "--server-command <value>",
    "Command to launch the MCP server (auto-resolved when using docsDir)",
  )
  .option("--server-arg <value>", "Server arg (repeatable)", collectValues, [] as string[])
  .option("--server-cwd <path>", "Working directory for server process")
  .option(
    "--server-env <key=value>",
    "Server environment variable (repeatable)",
    collectKeyValues,
    {} as Record<string, string>,
  )
  .option("--workspace-dir <path>", "Base directory for agent workspaces")
  .option(
    "--provider <value>",
    "Agent provider: anthropic, openai, or auto (default: auto)",
    "auto",
  )
  .option("--model <value>", "Model to use (defaults based on provider)")
  .option("--max-turns <number>", "Default max turns per scenario", parseIntOption, 15)
  .option(
    "--max-budget-usd <number>",
    "Default max budget per scenario in USD",
    parseFloatOption,
    0.5,
  )
  .option("--max-concurrency <number>", "Max concurrent scenarios", parseIntOption, 1)
  .option("--system-prompt <value>", "Custom system prompt for the agent")
  .option("--no-mcp", "Run without docs-mcp server (baseline mode)")
  .option("--compare", "Run with and without docs-mcp and compare results")
  .option("--debug", "Enable verbose agent event logging", false)
  .option("--no-judge", "Disable feedback tool for confidence scoring (enabled by default)")
  .option("--clean-workspace", "Delete workspace directories after run (default: keep)", false)
  .option("--no-save", "Skip auto-saving results to .eval-results/")
  .option("--out <path>", "Output JSON path")
  .action(
    async (options: {
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
      provider: string;
      model?: string;
      maxTurns: number;
      maxBudgetUsd: number;
      maxConcurrency: number;
      systemPrompt?: string;
      mcp: boolean;
      compare?: true;
      judge: boolean;
      debug: boolean;
      cleanWorkspace: boolean;
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
      if (options.compare && !options.mcp) {
        console.error("Error: --compare and --no-mcp are mutually exclusive");
        process.exit(1);
      }

      // Branch: comparison mode runs both phases
      if (options.compare) {
        await runCompare(options);
        return;
      }

      // Load scenarios
      const loaded = await loadScenarios(options);
      let { scenarios } = loaded;
      const { scenariosFilePath, config: suiteConfig } = loaded;

      // Filter by --include
      if (options.include) {
        const includeIds = new Set(options.include.split(",").map((s) => s.trim()));
        scenarios = scenarios.filter((s) => includeIds.has(s.id));
        if (scenarios.length === 0) {
          console.error(`Error: no scenarios matched --include "${options.include}"`);
          process.exit(1);
        }
      }

      const noMcp = !options.mcp;

      // Resolve links → set resolvedLinks on each scenario
      {
        const base = scenariosFilePath ? path.dirname(scenariosFilePath) : process.cwd();
        for (const scenario of scenarios) {
          if (scenario.links && Object.keys(scenario.links).length > 0) {
            const resolved: Record<string, string> = {};
            for (const [src, dest] of Object.entries(scenario.links)) {
              resolved[dest] = path.resolve(base, src);
            }
            scenario.resolvedLinks = resolved;
          }
        }
      }

      // Resolve docsDir → build indexes → set indexDir on each scenario (skip in no-mcp mode)
      let server:
        | {
            command: string;
            args: string[];
            cwd?: string;
            env?: Record<string, string>;
          }
        | undefined;

      if (!noMcp) {
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

            const cacheKey = `${resolvedDocsDir}\0${description ?? ""}\0${JSON.stringify(scenario.toolDescriptions ?? {})}`;
            let indexDir = indexCache.get(cacheKey);
            if (!indexDir) {
              indexDir = await ensureIndex(
                resolvedDocsDir,
                CLI_BIN_PATH,
                undefined,
                description,
                scenario.toolDescriptions,
              );
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

        server = options.serverCommand
          ? {
              command: options.serverCommand,
              args: options.serverArg,
              ...(options.serverCwd ? { cwd: path.resolve(options.serverCwd) } : {}),
              ...(Object.keys(options.serverEnv).length > 0 ? { env: options.serverEnv } : {}),
            }
          : undefined;
      }

      // Resolve agent provider
      const explicitProvider = options.provider === "auto" ? undefined : options.provider;
      const provider = await resolveAgentProvider(explicitProvider);
      // model is undefined when provider picks its own default (e.g. Codex CLI)
      const model = options.model ?? defaultModelForProvider(provider.name);

      const baseSuiteName =
        options.suite ??
        (options.scenarios
          ? path.basename(options.scenarios, path.extname(options.scenarios))
          : "ad-hoc");
      const suiteName = noMcp ? `${baseSuiteName}-baseline` : baseSuiteName;

      const feedbackToolConfig = suiteConfig?.feedbackToolConfig;

      const observer = new ConsoleObserver({
        model: model ?? `${provider.name} (default)`,
        suite: suiteName,
        debug: options.debug,
        ...(feedbackToolConfig !== undefined ? { feedbackToolConfig } : {}),
      });

      const output = await runAgentEval({
        scenarios,
        provider,
        ...(server ? { server } : {}),
        ...(options.workspaceDir ? { workspaceDir: path.resolve(options.workspaceDir) } : {}),
        ...(model ? { model } : {}),
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        maxConcurrency: options.maxConcurrency,
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        observer,
        debug: options.debug,
        judge: options.judge,
        cleanWorkspace: options.cleanWorkspace,
        noMcp,
        ...(feedbackToolConfig !== undefined ? { feedbackToolConfig } : {}),
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
    },
  );

void program.parseAsync(process.argv);

async function runCompare(options: {
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
  provider: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  maxConcurrency: number;
  systemPrompt?: string;
  judge: boolean;
  debug: boolean;
  cleanWorkspace: boolean;
  save: boolean;
  out?: string;
}): Promise<void> {
  const loaded = await loadScenarios(options);
  const { scenariosFilePath, config: suiteConfig } = loaded;

  let scenarios = loaded.scenarios;
  if (options.include) {
    const includeIds = new Set(options.include.split(",").map((s) => s.trim()));
    scenarios = scenarios.filter((s) => includeIds.has(s.id));
    if (scenarios.length === 0) {
      console.error(`Error: no scenarios matched --include "${options.include}"`);
      process.exit(1);
    }
  }

  const baseSuiteName =
    options.suite ??
    (options.scenarios
      ? path.basename(options.scenarios, path.extname(options.scenarios))
      : "ad-hoc");

  // Resolve agent provider + model (shared across both phases)
  const explicitProvider = options.provider === "auto" ? undefined : options.provider;
  const provider = await resolveAgentProvider(explicitProvider);
  const model = options.model ?? defaultModelForProvider(provider.name);
  const modelDisplay = model ?? `${provider.name} (default)`;

  // Resolve links → set resolvedLinks on each scenario
  {
    const base = scenariosFilePath ? path.dirname(scenariosFilePath) : process.cwd();
    for (const scenario of scenarios) {
      if (scenario.links && Object.keys(scenario.links).length > 0) {
        const resolved: Record<string, string> = {};
        for (const [src, dest] of Object.entries(scenario.links)) {
          resolved[dest] = path.resolve(base, src);
        }
        scenario.resolvedLinks = resolved;
      }
    }
  }

  // Build indexes (shared — both phases use the same index for MCP phase)
  const defaultDocsDir = options.docsDir ? path.resolve(options.docsDir) : undefined;
  const indexCache = new Map<string, string>();
  const indexDescriptions = new Map<string, string>();

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
      const description = scenario.description ?? indexDescriptions.get(resolvedDocsDir);
      if (scenario.description && !indexDescriptions.has(resolvedDocsDir)) {
        indexDescriptions.set(resolvedDocsDir, scenario.description);
      }

      const cacheKey = `${resolvedDocsDir}\0${description ?? ""}\0${JSON.stringify(scenario.toolDescriptions ?? {})}`;
      let indexDir = indexCache.get(cacheKey);
      if (!indexDir) {
        indexDir = await ensureIndex(
          resolvedDocsDir,
          CLI_BIN_PATH,
          undefined,
          description,
          scenario.toolDescriptions,
        );
        indexCache.set(cacheKey, indexDir);
      }
      scenario.indexDir = indexDir;
    }
  }

  // Verify server config for MCP phase
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
        ...(Object.keys(options.serverEnv).length > 0 ? { env: options.serverEnv } : {}),
      }
    : undefined;

  const feedbackToolConfig = suiteConfig?.feedbackToolConfig;

  // Shared config builder
  const buildEvalConfig = (noMcp: boolean, suiteName: string): AgentEvalConfig => {
    // Deep-clone scenarios so the baseline run doesn't see indexDir
    const clonedScenarios: AgentScenario[] = scenarios.map((s) => {
      if (!noMcp) return { ...s };
      const { indexDir: _, ...rest } = s;
      return rest;
    });

    const workspaceDir = options.workspaceDir
      ? path.resolve(options.workspaceDir, noMcp ? "baseline" : "with-mcp")
      : undefined;

    return {
      scenarios: clonedScenarios,
      provider,
      ...(server && !noMcp ? { server } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(model ? { model } : {}),
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      maxConcurrency: options.maxConcurrency,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      observer: new ConsoleObserver({
        model: modelDisplay,
        suite: suiteName,
        debug: options.debug,
        ...(feedbackToolConfig !== undefined ? { feedbackToolConfig } : {}),
      }),
      debug: options.debug,
      judge: options.judge,
      cleanWorkspace: options.cleanWorkspace,
      noMcp,
      ...(feedbackToolConfig !== undefined ? { feedbackToolConfig } : {}),
    };
  };

  // Phase 1: With MCP
  process.stderr.write("\n══════════════════════════════════════════════════\n");
  process.stderr.write("  Phase 1: Running with docs-mcp\n");
  process.stderr.write("══════════════════════════════════════════════════\n");

  const withMcpSuite = baseSuiteName;
  const withMcpOutput = await runAgentEval(buildEvalConfig(false, `${withMcpSuite} [with MCP]`));

  if (options.save !== false) {
    const savedPath = await saveResult(withMcpOutput, withMcpSuite);
    process.stderr.write(`\nResults saved to ${savedPath}\n`);
  }

  // Phase 2: Without MCP (baseline)
  process.stderr.write("\n══════════════════════════════════════════════════\n");
  process.stderr.write("  Phase 2: Running baseline (no MCP)\n");
  process.stderr.write("══════════════════════════════════════════════════\n");

  const baselineSuite = `${baseSuiteName}-baseline`;
  const withoutMcpOutput = await runAgentEval(buildEvalConfig(true, `${baselineSuite} [baseline — no MCP]`));

  if (options.save !== false) {
    const savedPath = await saveResult(withoutMcpOutput, baselineSuite);
    process.stderr.write(`\nResults saved to ${savedPath}\n`);
  }

  // Build + print comparison
  const comparison = buildComparison(withMcpOutput, withoutMcpOutput, baseSuiteName);
  const report = formatComparisonReport(comparison);
  process.stderr.write(`${report}\n`);

  // Write comparison JSON
  if (options.out) {
    const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
    const outPath = path.resolve(options.out);
    await writeFile(outPath, serialized);
    process.stderr.write(`Wrote comparison result to ${outPath}\n`);
  }
}

interface SuiteConfig {
  feedbackToolConfig?: FeedbackToolConfig;
}

interface LoadedSuite {
  scenarios: AgentScenario[];
  scenariosFilePath?: string;
  config?: SuiteConfig;
}

async function loadScenarios(options: {
  suite?: string;
  scenarios?: string;
  prompt?: string;
  docsDir?: string;
}): Promise<LoadedSuite> {
  if (options.suite) {
    const filePath = await resolveSuiteFile(options.suite);
    const raw = await readFile(filePath, "utf8");
    const result = parseScenarioFile(raw);
    return { scenarios: result.scenarios, scenariosFilePath: filePath, ...(result.config !== undefined ? { config: result.config } : {}) };
  }
  if (options.scenarios) {
    const filePath = path.resolve(options.scenarios);
    const raw = await readFile(filePath, "utf8");
    const result = parseScenarioFile(raw);
    return { scenarios: result.scenarios, scenariosFilePath: filePath, ...(result.config !== undefined ? { config: result.config } : {}) };
  }
  // --prompt mode
  return {
    scenarios: [
      {
        id: "ad-hoc",
        name: "ad-hoc",
        prompt: options.prompt!,
        assertions: [],
        docsDir: options.docsDir!,
      },
    ],
  };
}

async function resolveSuiteFile(suite: string): Promise<string> {
  for (const ext of [".yaml", ".yml"]) {
    const candidate = path.join(FIXTURES_DIR, `${suite}${ext}`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next extension
    }
  }
  // Fall back to .yaml for a clear error message
  return path.join(FIXTURES_DIR, `${suite}.yaml`);
}

interface ParsedSuiteFile {
  scenarios: AgentScenario[];
  config?: SuiteConfig;
}

function parseScenarioFile(raw: string): ParsedSuiteFile {
  const parsed = YAML.parse(raw, { merge: true }) as unknown;

  // Legacy array format — auto-generate ids from names
  if (Array.isArray(parsed)) {
    return {
      scenarios: (parsed as AgentScenario[]).map((s) => ({
        ...s,
        id: s.id ?? slugify(s.name),
      })),
    };
  }

  const record = parsed as Record<string, unknown>;

  // Extract suite-level config from _config key
  let config: SuiteConfig | undefined;
  if (record._config && typeof record._config === "object" && !Array.isArray(record._config)) {
    const rawConfig = record._config as Record<string, unknown>;
    if (rawConfig.feedback_tool && typeof rawConfig.feedback_tool === "object") {
      config = {
        feedbackToolConfig: parseFeedbackToolYaml(
          rawConfig.feedback_tool as Record<string, unknown>,
        ),
      };
    }
  }

  // K:V format — key is the scenario id. Strip keys starting with "_" (YAML anchor-only entries).
  const scenarios = Object.entries(record)
    .filter(([id]) => !id.startsWith("_"))
    .map(([id, scenario]) => ({ ...(scenario as Omit<AgentScenario, "id">), id }));

  return { scenarios, ...(config !== undefined ? { config } : {}) };
}

/** Convert snake_case YAML feedback_tool config to FeedbackToolConfig. */
function parseFeedbackToolYaml(raw: Record<string, unknown>): FeedbackToolConfig {
  const metrics = Array.isArray(raw.metrics)
    ? (raw.metrics as Array<Record<string, unknown>>).map((m) => ({
        field: String(m.field),
        label: String(m.label),
        direction: (m.direction === "lower" ? "lower" : "higher") as "higher" | "lower",
      }))
    : [];

  return {
    name: String(raw.name),
    description: String(raw.description),
    instruction: String(raw.instruction),
    inputSchema: raw.input_schema as FeedbackToolConfig["inputSchema"],
    metrics,
    ...(typeof raw.reasoning_field === "string" ? { reasoningField: raw.reasoning_field } : {}),
    ...(typeof raw.headline_field === "string" ? { headlineField: raw.headline_field } : {}),
  };
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
