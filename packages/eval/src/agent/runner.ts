import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evaluateAssertions } from "./assertions.js";
import { computeAgentEvalSummary } from "./metrics.js";
import { NoopObserver } from "./observer.js";
import type {
  AgentEvalConfig,
  AgentEvalObserver,
  AgentEvalOutput,
  AgentScenario,
  AgentScenarioResult,
  ToolCallRecord,
  WorkspaceFile
} from "./types.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BIN_PATH = path.resolve(__dirname, "..", "..", "..", "server", "dist", "bin.js");

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_BUDGET_USD = 0.50;
const DOCS_MCP_TOOLS = new Set(["mcp__docs-mcp__search_docs", "mcp__docs-mcp__get_doc"]);

const DEFAULT_SYSTEM_PROMPT = `You are an interactive assistant that helps users with software engineering tasks. Use the tools available to you to assist the user.

You have access to documentation tools for this project. Use search_docs and get_doc when you need exact API signatures, supported options, or authoritative SDK behavior. Otherwise, rely on your own knowledge and reasoning.

Write clean, correct code. Write all files in the current working directory using relative paths (e.g. ./solution.ts, not absolute paths).`;

export async function runAgentEval(config: AgentEvalConfig): Promise<AgentEvalOutput> {
  const observer = config.observer ?? new NoopObserver();
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const model = config.model ?? DEFAULT_MODEL;

  const maxConcurrency = config.maxConcurrency ?? 1;
  const results: AgentScenarioResult[] = [];

  if (maxConcurrency <= 1) {
    for (let i = 0; i < config.scenarios.length; i++) {
      const scenario = config.scenarios[i]!;
      observer.onScenarioStart(scenario, i, config.scenarios.length);
      const result = await runAgentScenario(scenario, config, observer);
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
        const result = await runAgentScenario(item.scenario, config, observer);
        results[item.index] = result;
        observer.onScenarioComplete(item.scenario, result);
      }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrency, queue.length) }, () => worker()));
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = performance.now() - startMs;

  const output: AgentEvalOutput = {
    summary: computeAgentEvalSummary(results),
    results,
    metadata: { model, startedAt, completedAt, totalDurationMs }
  };

  observer.onEvalComplete(output);
  return output;
}

export async function runAgentScenario(
  scenario: AgentScenario,
  config: AgentEvalConfig,
  observer?: AgentEvalObserver
): Promise<AgentScenarioResult> {
  const maxTurns = scenario.maxTurns ?? config.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = scenario.maxBudgetUsd ?? config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const systemPrompt = scenario.systemPrompt ?? config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const workspaceDir = config.workspaceDir
    ? path.join(config.workspaceDir, scenario.id)
    : await mkdtemp(path.join(tmpdir(), "agent-eval-"));

  try {
    await mkdir(workspaceDir, { recursive: true });

    const errors: string[] = [];

    if (scenario.setup) {
      try {
        await execFileAsync("sh", ["-c", scenario.setup], {
          cwd: workspaceDir,
          timeout: 60_000,
          env: process.env as Record<string, string>
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

    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown>; startMs: number }>();

    // Build MCP server config (skipped in noMcp baseline mode)
    let mcpServerConfig: { command: string; args?: string[]; env?: Record<string, string> } | undefined;

    if (!config.noMcp) {
      const serverEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) serverEnv[k] = v;
      }
      if (config.server?.env) {
        Object.assign(serverEnv, config.server.env);
      }

      if (scenario.indexDir) {
        mcpServerConfig = {
          command: "node",
          args: [SERVER_BIN_PATH, "--index-dir", scenario.indexDir],
          env: serverEnv
        };
      } else if (config.server) {
        mcpServerConfig = {
          command: config.server.command,
          ...(config.server.args ? { args: config.server.args } : {}),
          env: serverEnv
        };
      } else {
        throw new Error(`Scenario "${scenario.name}" has no indexDir and no server config provided`);
      }
    }

    const allowedTools = mcpServerConfig
      ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "mcp__docs-mcp__*"]
      : ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

    try {
      for await (const message of query({
        prompt: scenario.prompt,
        options: {
          model: config.model ?? DEFAULT_MODEL,
          systemPrompt,
          allowedTools,
          ...(mcpServerConfig ? { mcpServers: { "docs-mcp": mcpServerConfig } } : {}),
          maxTurns,
          maxBudgetUsd,
          cwd: workspaceDir,
          env: process.env as Record<string, string>,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false
        }
      })) {
        const nowMs = performance.now() - startMs;

        if (message.type === "system" && message.subtype === "init") {
          // Verify docs-mcp tools are registered
          const mcpTools = message.tools.filter((t: string) => t.startsWith("mcp__docs"));
          const mcpServers = (message.mcp_servers ?? []) as Array<{ name: string; status: string }>;
          const docsMcpServer = mcpServers.find((s) => s.name === "docs-mcp");

          const parts = [
            `model=${message.model}`,
            `tools=${message.tools.length}`,
            `mcp_tools=[${mcpTools.join(", ")}]`,
            `docs-mcp=${docsMcpServer ? docsMcpServer.status : "not found"}`
          ];

          if (mcpTools.length === 0 && !config.noMcp) {
            errors.push("docs-mcp tools not registered — server may have failed to start");
          }

          observer?.onAgentMessage(scenario, {
            type: "system_init",
            summary: parts.join(", "),
            timestampMs: nowMs
          });
        }

        if (message.type === "assistant") {
          numTurns++;
          if (message.message.usage) {
            const usage = message.message.usage as Record<string, number>;
            inputTokens += usage.input_tokens ?? 0;
            outputTokens += usage.output_tokens ?? 0;
            cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
            cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
          }

          for (const block of message.message.content) {
            if ("text" in block && block.text) {
              finalAnswer = block.text;
              observer?.onAgentMessage(scenario, {
                type: "assistant_text",
                summary: block.text.slice(0, 150) + (block.text.length > 150 ? "..." : ""),
                timestampMs: nowMs
              });
            }

            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolArgs = (block.input ?? {}) as Record<string, unknown>;
              toolsCalled[toolName] = (toolsCalled[toolName] ?? 0) + 1;

              if (DOCS_MCP_TOOLS.has(toolName)) {
                activated = true;
              }

              pendingToolCalls.set(block.id, { name: toolName, args: toolArgs, startMs: performance.now() });

              observer?.onAgentMessage(scenario, {
                type: "tool_call",
                summary: `${toolName}(${summarizeArgs(toolArgs)})`,
                toolArgs,
                timestampMs: nowMs
              });
            }
          }
        }

        if (message.type === "user" && message.tool_use_result != null) {
          const toolResult = message.tool_use_result as Record<string, unknown>;
          const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : undefined;
          const resultText = extractToolResultText(toolResult);
          const pending = toolUseId ? pendingToolCalls.get(toolUseId) : undefined;

          if (pending && toolUseId) {
            toolCallTrace.push({
              name: pending.name,
              args: pending.args,
              result: resultText,
              durationMs: performance.now() - pending.startMs,
              timestampMs: pending.startMs - startMs
            });
            pendingToolCalls.delete(toolUseId);
          }

          observer?.onAgentMessage(scenario, {
            type: "tool_result",
            summary: "Tool result received",
            toolResultPreview: resultText.slice(0, 2000),
            timestampMs: performance.now() - startMs
          });
        }

        if (message.type === "result") {
          resultSubtype = message.subtype;
          totalCostUsd = message.total_cost_usd;
          durationApiMs = message.duration_api_ms;
          numTurns = message.num_turns;
          const resultUsage = message.usage as Record<string, number>;
          inputTokens = resultUsage.input_tokens ?? 0;
          outputTokens = resultUsage.output_tokens ?? 0;
          cacheReadInputTokens = resultUsage.cache_read_input_tokens ?? 0;
          cacheCreationInputTokens = resultUsage.cache_creation_input_tokens ?? 0;
          if (message.subtype === "success") {
            finalAnswer = message.result;
          } else {
            errors.push(...message.errors);
          }

          observer?.onAgentMessage(scenario, {
            type: "result",
            summary: `Result: ${resultSubtype} ($${totalCostUsd.toFixed(4)}, ${numTurns} turns)`,
            timestampMs: performance.now() - startMs
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Agent error: ${msg}`);
    }

    const durationMs = performance.now() - startMs;

    const assertionResults = await evaluateAssertions(finalAnswer, scenario.assertions, workspaceDir);
    const hard = assertionResults.filter((r) => !r.assertion.soft);
    const passed = hard.length > 0 && hard.every((r) => r.passed);

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

    return {
      id: scenario.id,
      name: scenario.name,
      ...(scenario.category !== undefined ? { category: scenario.category } : {}),
      activated,
      passed,
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
      ...(errors.length > 0 ? { errors } : {})
    };
  } finally {
    if (!config.debug && !config.workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const parts = entries.slice(0, 3).map(([k, v]) => {
    const val = typeof v === "string" ? (v.length > 40 ? `"${v.slice(0, 40)}..."` : `"${v}"`) : JSON.stringify(v);
    return `${k}=${val}`;
  });
  if (entries.length > 3) parts.push("...");
  return parts.join(", ");
}

const MAX_FILE_CONTENT = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", html: "html", css: "css", sql: "sql"
};

async function collectWorkspaceFiles(
  trace: ToolCallRecord[],
  workspaceDir: string
): Promise<WorkspaceFile[]> {
  // Dedupe file paths from Write/Edit tool calls (preserving last-seen order)
  const filePaths = new Map<string, true>();
  for (const record of trace) {
    if ((record.name === "Write" || record.name === "Edit") && typeof record.args.file_path === "string") {
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
        ...(EXT_LANG[ext] ? { lang: EXT_LANG[ext] } : ext ? { lang: ext } : {})
      });
    } catch {
      // File may have been deleted by the agent
    }
  }
  return files;
}

function extractToolResultText(toolResult: Record<string, unknown>): string {
  if (typeof toolResult.content === "string") return toolResult.content;
  if (Array.isArray(toolResult.content)) {
    return (toolResult.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return JSON.stringify(toolResult);
}
