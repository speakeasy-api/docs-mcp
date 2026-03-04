import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evaluateAssertions } from "./assertions.js";
import { DEFAULT_FEEDBACK_TOOL_CONFIG, parseFeedbackResult } from "./feedback.js";
import { computeAgentEvalSummary } from "./metrics.js";
import { NoopObserver } from "./observer.js";
import { defaultModelForProvider } from "./provider.js";
import { ClaudeAgentProvider } from "./provider-claude.js";
import type {
  AgentEvalConfig,
  AgentEvalObserver,
  AgentEvalOutput,
  FeedbackResult,
  FeedbackToolConfig,
  AgentScenario,
  AgentScenarioResult,
  ToolCallRecord,
  WorkspaceFile,
} from "./types.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BIN_PATH = path.resolve(__dirname, "..", "..", "..", "server", "dist", "bin.js");

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_BUDGET_USD = 4.0;
const DOCS_MCP_TOOLS = new Set(["mcp__docs-mcp__search_docs", "mcp__docs-mcp__get_doc"]);

const DEFAULT_SYSTEM_PROMPT =
  "Write all output files to the current working directory. Do not create new directories or use absolute paths from documentation examples.";

export async function runAgentEval(config: AgentEvalConfig): Promise<AgentEvalOutput> {
  const observer = config.observer ?? new NoopObserver();
  const provider = config.provider ?? new ClaudeAgentProvider();
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  // model may be undefined when the provider picks its own default (e.g. Codex CLI)
  const model = config.model ?? defaultModelForProvider(provider.name);

  const maxConcurrency = config.maxConcurrency ?? 1;
  const results: AgentScenarioResult[] = [];

  if (maxConcurrency <= 1) {
    for (let i = 0; i < config.scenarios.length; i++) {
      const scenario = config.scenarios[i]!;
      observer.onScenarioStart(scenario, i, config.scenarios.length);
      const result = await runAgentScenario(scenario, config, provider, observer);
      results.push(result);
      observer.onScenarioComplete(scenario, result);
    }
  } else {
    const queue = config.scenarios.map((s, i) => ({ scenario: s, index: i }));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const item = queue[idx]!;
        observer.onScenarioStart(item.scenario, item.index, config.scenarios.length);
        const result = await runAgentScenario(item.scenario, config, provider, observer);
        results[item.index] = result;
        observer.onScenarioComplete(item.scenario, result);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, queue.length) }, () => worker()),
    );
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = performance.now() - startMs;

  const output: AgentEvalOutput = {
    summary: computeAgentEvalSummary(results),
    results,
    metadata: {
      model: model ?? `${provider.name} (default)`,
      startedAt,
      completedAt,
      totalDurationMs,
    },
  };

  observer.onEvalComplete(output);
  return output;
}

export async function runAgentScenario(
  scenario: AgentScenario,
  config: AgentEvalConfig,
  provider = config.provider ?? new ClaudeAgentProvider(),
  observer?: AgentEvalObserver,
): Promise<AgentScenarioResult> {
  const model =
    scenario.models?.[provider.name] ?? config.model ?? defaultModelForProvider(provider.name);
  const maxTurns = scenario.maxTurns ?? config.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = scenario.maxBudgetUsd ?? config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const judge = config.judge !== false;
  const feedbackConfig: FeedbackToolConfig | undefined =
    judge && !config.noMcp
      ? (config.feedbackToolConfig ?? DEFAULT_FEEDBACK_TOOL_CONFIG)
      : undefined;
  const feedbackToolFqn = feedbackConfig ? `mcp__docs-mcp__${feedbackConfig.name}` : undefined;
  const customSystemPrompt = scenario.systemPrompt ?? config.systemPrompt;
  const feedbackInstruction = feedbackConfig ? `\n\n${feedbackConfig.instruction}` : "";
  const systemPrompt = customSystemPrompt
    ? `${DEFAULT_SYSTEM_PROMPT}\n\n${customSystemPrompt}${feedbackInstruction}`
    : `${DEFAULT_SYSTEM_PROMPT}${feedbackInstruction}`;

  const workspaceDir = config.workspaceDir
    ? path.join(config.workspaceDir, scenario.id)
    : await mkdtemp(path.join(tmpdir(), "agent-eval-"));

  try {
    await mkdir(workspaceDir, { recursive: true });

    const errors: string[] = [];

    // Create symlinks for scenario links (before setup so setup can use them)
    if (scenario.resolvedLinks) {
      for (const [dest, src] of Object.entries(scenario.resolvedLinks)) {
        const linkPath = path.join(workspaceDir, dest);
        await mkdir(path.dirname(linkPath), { recursive: true });
        try {
          await symlink(src, linkPath);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Link warning: failed to symlink ${src} → ${dest}: ${msg}`);
        }
      }
    }

    if (scenario.setup) {
      try {
        await execFileAsync("sh", ["-c", scenario.setup], {
          cwd: workspaceDir,
          timeout: 60_000,
          env: process.env as Record<string, string>,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Setup warning: ${msg}`);
      }
    }

    const startMs = performance.now();
    const toolsCalled: Record<string, number> = {};
    const toolCallTrace: ToolCallRecord[] = [];
    let activated = false;
    let finalAnswer = "";
    let resultSubtype = "success";
    let numTurns = 0;
    let totalCostUsd = 0;
    let durationApiMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;

    const pendingToolCalls = new Map<
      string,
      { name: string; args: Record<string, unknown>; startMs: number }
    >();

    // Build MCP server config (skipped in noMcp baseline mode)
    let mcpServers:
      | Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
      | undefined;

    if (!config.noMcp) {
      const serverEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) serverEnv[k] = v;
      }
      if (config.server?.env) {
        Object.assign(serverEnv, config.server.env);
      }

      let mcpServerConfig:
        | { command: string; args?: string[]; env?: Record<string, string> }
        | undefined;

      if (scenario.indexDir) {
        const serverArgs = [SERVER_BIN_PATH, "--index-dir", scenario.indexDir];
        if (feedbackConfig) {
          const toolDefs = [
            {
              name: feedbackConfig.name,
              description: feedbackConfig.description,
              inputSchema: feedbackConfig.inputSchema,
            },
          ];
          serverArgs.push("--custom-tools-json", JSON.stringify(toolDefs));
        }
        mcpServerConfig = {
          command: "node",
          args: serverArgs,
          env: serverEnv,
        };
      } else if (config.server) {
        mcpServerConfig = {
          command: config.server.command,
          ...(config.server.args ? { args: config.server.args } : {}),
          env: serverEnv,
        };
      } else {
        throw new Error(
          `Scenario "${scenario.name}" has no indexDir and no server config provided`,
        );
      }

      mcpServers = { "docs-mcp": mcpServerConfig };
    }

    const allowedTools = mcpServers
      ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__docs-mcp__*"]
      : ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

    try {
      for await (const event of provider.run({
        ...(model ? { model } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        prompt: scenario.prompt,
        workspaceDir,
        maxTurns,
        maxBudgetUsd,
        ...(mcpServers ? { mcpServers } : {}),
        allowedTools,
        env: process.env as Record<string, string>,
        ...(config.debug != null ? { debug: config.debug } : {}),
      })) {
        const nowMs = performance.now() - startMs;

        switch (event.type) {
          case "init": {
            const mcpTools = event.tools.filter((t: string) => t.startsWith("mcp__docs"));
            const docsMcpServer = event.mcpServers.find((s) => s.name === "docs-mcp");

            const parts = [
              `model=${event.model}`,
              `tools=${event.tools.length}`,
              `mcp_tools=[${mcpTools.join(", ")}]`,
              `docs-mcp=${docsMcpServer ? docsMcpServer.status : "not found"}`,
            ];

            if (mcpTools.length === 0 && !config.noMcp) {
              errors.push("docs-mcp tools not registered — server may have failed to start");
            }

            observer?.onAgentMessage(scenario, {
              type: "system_init",
              summary: parts.join(", "),
              workspaceDir,
              timestampMs: nowMs,
            });
            break;
          }

          case "text": {
            finalAnswer = event.text;
            if (event.usage) {
              numTurns++;
              inputTokens += event.usage.inputTokens;
              outputTokens += event.usage.outputTokens;
              cacheReadInputTokens += event.usage.cacheReadInputTokens ?? 0;
              cacheCreationInputTokens += event.usage.cacheCreationInputTokens ?? 0;
            }

            observer?.onAgentMessage(scenario, {
              type: "assistant_text",
              summary: event.text,
              fullText: event.text,
              timestampMs: nowMs,
            });
            break;
          }

          case "tool_call": {
            const toolName = event.name;
            toolsCalled[toolName] = (toolsCalled[toolName] ?? 0) + 1;

            if (DOCS_MCP_TOOLS.has(toolName)) {
              activated = true;
            }

            pendingToolCalls.set(event.id, {
              name: toolName,
              args: event.args,
              startMs: performance.now(),
            });

            observer?.onAgentMessage(scenario, {
              type: "tool_call",
              summary: `${toolName}(${summarizeArgs(event.args)})`,
              toolName,
              toolArgs: event.args,
              timestampMs: nowMs,
            });
            break;
          }

          case "tool_result": {
            const pending = pendingToolCalls.get(event.id);

            if (pending) {
              toolCallTrace.push({
                name: pending.name,
                args: pending.args,
                result: event.result,
                durationMs: performance.now() - pending.startMs,
                timestampMs: pending.startMs - startMs,
              });
              pendingToolCalls.delete(event.id);
            }

            observer?.onAgentMessage(scenario, {
              type: "tool_result",
              summary: "Tool result received",
              toolResultPreview: event.result.slice(0, 2000),
              timestampMs: performance.now() - startMs,
            });
            break;
          }

          case "done": {
            resultSubtype = event.subtype;
            totalCostUsd = event.usage.totalCostUsd;
            durationApiMs = event.usage.durationApiMs;
            numTurns = event.usage.numTurns;
            inputTokens = event.usage.inputTokens;
            outputTokens = event.usage.outputTokens;
            cacheReadInputTokens = event.usage.cacheReadInputTokens;
            cacheCreationInputTokens = event.usage.cacheCreationInputTokens;
            if (event.subtype === "success") {
              finalAnswer = event.answer;
            } else {
              errors.push(...event.errors);
              // Safety net: if the provider didn't give us error details,
              // synthesize from context so we never show a bare "Result: error".
              if (event.errors.length === 0) {
                errors.push("Agent ended with error (no details from provider)");
              }
            }

            // Include the first provider error in the summary line for quick scanning
            const providerError =
              event.subtype !== "success" && event.errors.length > 0 ? event.errors[0]! : undefined;
            const reasonHint = providerError
              ? ` — ${providerError.length > 60 ? providerError.slice(0, 60) + "…" : providerError}`
              : "";

            observer?.onAgentMessage(scenario, {
              type: "result",
              summary: `Result: ${resultSubtype}${reasonHint} ($${totalCostUsd.toFixed(4)}, ${numTurns} turns)`,
              timestampMs: performance.now() - startMs,
            });
            break;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Agent error: ${msg}`);
    }

    const durationMs = performance.now() - startMs;

    // Detect infrastructure errors (API overload, etc.) that should not count as test failures
    const INFRA_ERROR_PATTERN = /529|overload|API Error.*Repeated/i;
    const hasInfraError = errors.some((e) => INFRA_ERROR_PATTERN.test(e));

    const assertionResults = await evaluateAssertions(
      finalAnswer,
      scenario.assertions,
      workspaceDir,
    );
    const hard = assertionResults.filter((r) => !r.assertion.soft);
    const passed = hasInfraError ? false : hard.length > 0 && hard.every((r) => r.passed);

    // Collect workspace files written by the agent
    const workspaceFiles = await collectWorkspaceFiles(toolCallTrace, workspaceDir);

    // MCP-specific metrics
    let mcpToolCalls = 0;
    for (const [tool, count] of Object.entries(toolsCalled)) {
      if (DOCS_MCP_TOOLS.has(tool)) mcpToolCalls += count;
    }
    let mcpToolResultChars = 0;
    for (const trace of toolCallTrace) {
      if (DOCS_MCP_TOOLS.has(trace.name)) mcpToolResultChars += trace.result.length;
    }

    // Extract feedback from tool trace
    let feedbackResult: FeedbackResult | undefined;
    if (feedbackConfig && feedbackToolFqn) {
      const feedbackCall = toolCallTrace.find((t) => t.name === feedbackToolFqn);
      if (feedbackCall) {
        feedbackResult = parseFeedbackResult(feedbackCall.args, feedbackConfig);
      }
    }

    return {
      id: scenario.id,
      name: scenario.name,
      ...(scenario.category !== undefined ? { category: scenario.category } : {}),
      activated,
      passed,
      ...(hasInfraError ? { skipped: true } : {}),
      assertionResults,
      numTurns,
      totalCostUsd,
      durationMs,
      durationApiMs,
      toolsCalled,
      toolCallTrace,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      mcpToolCalls,
      mcpToolResultChars,
      workspaceFiles,
      finalAnswer,
      resultSubtype,
      workspaceDir,
      ...(errors.length > 0 ? { errors } : {}),
      ...(feedbackResult !== undefined ? { feedbackResult } : {}),
    };
  } finally {
    if (config.cleanWorkspace) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const parts = entries.slice(0, 3).map(([k, v]) => {
    const val =
      typeof v === "string"
        ? v.length > 40
          ? `"${v.slice(0, 40)}..."`
          : `"${v}"`
        : JSON.stringify(v);
    return `${k}=${val}`;
  });
  if (entries.length > 3) parts.push("...");
  return parts.join(", ");
}

const MAX_FILE_CONTENT = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  html: "html",
  css: "css",
  sql: "sql",
};

async function collectWorkspaceFiles(
  trace: ToolCallRecord[],
  workspaceDir: string,
): Promise<WorkspaceFile[]> {
  // Dedupe file paths from Write/Edit tool calls (preserving last-seen order)
  const filePaths = new Map<string, true>();
  for (const record of trace) {
    if (
      (record.name === "Write" || record.name === "Edit") &&
      typeof record.args.file_path === "string"
    ) {
      filePaths.set(record.args.file_path, true);
    }
  }

  const files: WorkspaceFile[] = [];
  for (const relPath of filePaths.keys()) {
    const absPath = path.resolve(workspaceDir, relPath);
    // Ensure it's within workspace
    if (!absPath.startsWith(workspaceDir)) continue;
    try {
      let content = await readFile(absPath, "utf8");
      if (content.length > MAX_FILE_CONTENT) {
        content = content.slice(0, MAX_FILE_CONTENT);
      }
      const ext = path.extname(relPath).replace(/^\./, "");
      files.push({
        path: relPath,
        content,
        ...(EXT_LANG[ext] ? { lang: EXT_LANG[ext] } : ext ? { lang: ext } : {}),
      });
    } catch {
      // File may have been deleted by the agent
    }
  }
  return files;
}
