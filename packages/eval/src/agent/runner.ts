import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { evaluateAssertions } from "./assertions.js";
import { ensureIndex } from "./build-cache.js";
import { computeAgentEvalSummary } from "./metrics.js";
import { NoopObserver } from "./observer.js";
import type {
  AgentEvalConfig,
  AgentEvalObserver,
  AgentEvalOutput,
  AgentScenario,
  AgentScenarioResult,
  ToolCallRecord
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TURNS = 15;
const DEFAULT_MAX_BUDGET_USD = 0.50;
const DOCS_MCP_TOOLS = new Set(["mcp__docs-mcp__search_docs", "mcp__docs-mcp__get_doc"]);

const DEFAULT_SYSTEM_PROMPT = `You are an expert TypeScript developer. You have access to documentation search tools for an SDK.
Use the docs-mcp tools (search_docs, get_doc) to find relevant documentation, then write code based on what you learn.
Always install dependencies before writing code. Write clean, working TypeScript code.`;

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
      const result = await runAgentScenario(scenario, i, config, observer);
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
        const result = await runAgentScenario(item.scenario, item.index, config, observer);
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
  scenarioIndex: number,
  config: AgentEvalConfig,
  observer?: AgentEvalObserver
): Promise<AgentScenarioResult> {
  const maxTurns = scenario.maxTurns ?? config.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = scenario.maxBudgetUsd ?? config.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const systemPrompt = scenario.systemPrompt ?? config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const workspaceDir = config.workspaceDir
    ? path.join(config.workspaceDir, sanitizeName(scenario.name))
    : await mkdtemp(path.join(tmpdir(), "agent-eval-"));

  try {
    await mkdir(workspaceDir, { recursive: true });

    if (scenario.setup) {
      await execFileAsync("sh", ["-c", scenario.setup], {
        cwd: workspaceDir,
        timeout: 60_000,
        env: process.env as Record<string, string>
      });
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
    const errors: string[] = [];

    const pendingToolCalls = new Map<string, { name: string; args: Record<string, unknown>; startMs: number }>();

    const serverEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) serverEnv[k] = v;
    }
    if (config.server.env) {
      Object.assign(serverEnv, config.server.env);
    }

    // Per-scenario server config: if docsDir is set, auto-build index and spawn server
    const resolvedDocsDir = config.resolvedDocsDirs?.get(scenarioIndex);
    let mcpServerConfig: { command: string; args?: string[]; env?: Record<string, string> };

    if (resolvedDocsDir && config.cliBinPath && config.serverBinPath) {
      const indexDir = await ensureIndex(resolvedDocsDir, config.cliBinPath, config.cacheDir);
      mcpServerConfig = {
        command: "node",
        args: [config.serverBinPath, "--index-dir", indexDir],
        env: serverEnv
      };
    } else {
      mcpServerConfig = {
        command: config.server.command,
        ...(config.server.args ? { args: config.server.args } : {}),
        env: serverEnv
      };
    }

    try {
      for await (const message of query({
        prompt: scenario.prompt,
        options: {
          model: config.model ?? DEFAULT_MODEL,
          systemPrompt,
          allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
          mcpServers: { "docs-mcp": mcpServerConfig },
          maxTurns,
          maxBudgetUsd,
          cwd: workspaceDir,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: false
        }
      })) {
        const nowMs = performance.now() - startMs;

        if (message.type === "system" && message.subtype === "init") {
          observer?.onAgentMessage(scenario, {
            type: "system_init",
            summary: `Session initialized: model=${message.model}, tools=${message.tools.length}`,
            timestampMs: nowMs
          });
        }

        if (message.type === "assistant") {
          numTurns++;
          if (message.message.usage) {
            inputTokens += message.message.usage.input_tokens ?? 0;
            outputTokens += message.message.usage.output_tokens ?? 0;
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
            toolResultPreview: resultText.slice(0, 200) + (resultText.length > 200 ? "..." : ""),
            timestampMs: performance.now() - startMs
          });
        }

        if (message.type === "result") {
          resultSubtype = message.subtype;
          totalCostUsd = message.total_cost_usd;
          durationApiMs = message.duration_api_ms;
          numTurns = message.num_turns;
          inputTokens = message.usage.input_tokens;
          outputTokens = message.usage.output_tokens;
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
    const passed = assertionResults.length > 0 && assertionResults.every((r) => r.passed);

    return {
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

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
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
