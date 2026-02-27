import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentProvider,
  AgentProviderConfig,
  AgentProviderEvent,
  RunUsage,
} from "./provider.js";

// Known OpenAI model pricing (USD per 1M tokens).
// Codex CLI does not expose cost metadata — this table must be maintained manually.
// When a model is missing, cost is reported as 0 with a stderr warning.
const OPENAI_PRICING: Record<string, { input: number; output: number }> = {
  // GPT-5 Codex family (agentic coding models)
  "gpt-5.3-codex": { input: 2.0, output: 8.0 },
  "gpt-5.2-codex": { input: 2.0, output: 8.0 },
  "gpt-5.1-codex": { input: 2.0, output: 8.0 },
  "gpt-5.1-codex-max": { input: 5.0, output: 20.0 },
  "gpt-5-codex": { input: 2.0, output: 8.0 },
  "gpt-5.1-codex-mini": { input: 0.3, output: 1.2 },
  "gpt-5-codex-mini": { input: 0.3, output: 1.2 },
  // GPT-5 base
  "gpt-5.2": { input: 2.0, output: 8.0 },
  "gpt-5.1": { input: 2.0, output: 8.0 },
  "gpt-5": { input: 2.0, output: 8.0 },
  // Legacy reasoning models
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 10.0, output: 40.0 },
  "codex-mini-latest": { input: 1.5, output: 6.0 },
};

const warnedModels = new Set<string>();

function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) {
    if (!warnedModels.has("(default)")) {
      warnedModels.add("(default)");
      process.stderr.write(
        "Warning: codex used its default model — cost estimate unavailable. Pass --model to enable cost tracking.\n",
      );
    }
    return 0;
  }
  const pricing = OPENAI_PRICING[model];
  if (!pricing) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      process.stderr.write(
        `Warning: no pricing data for model "${model}" — cost will be reported as $0. Update OPENAI_PRICING in provider-codex.ts.\n`,
      );
    }
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

/** Shell-quote a single argument for display (not for execution). */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Extract text output from a Codex MCP tool call result.
 * Result is `{ content: [{type:"text", text:"..."}], structured_content?: {...} }`.
 */
function extractMcpToolOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return (r.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
    }
    return JSON.stringify(result);
  }
  return JSON.stringify(result ?? "");
}

/**
 * Pre-flight check: spawn the MCP server directly and verify it responds to
 * the MCP initialize + tools/list handshake. Returns the discovered tool names
 * or throws with a descriptive error.
 */
async function verifyMcpServer(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`MCP server timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`));
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`MCP server failed to spawn: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(new Error(`MCP server exited (code ${code}) with no output. stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      // Parse the tools/list response
      try {
        const toolNames = parseMcpToolsFromOutput(stdout);
        resolve(toolNames);
      } catch (err) {
        reject(new Error(`MCP server responded but tools/list parse failed: ${err instanceof Error ? err.message : err}. stdout: ${stdout.slice(0, 500)}`));
      }
    });

    // Send MCP initialize + tools/list over stdin (JSON-RPC over stdio)
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "eval-preflight", version: "1.0" },
      },
    });
    const initialized = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const toolsList = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    child.stdin!.write(initialize + "\n");
    child.stdin!.write(initialized + "\n");
    child.stdin!.write(toolsList + "\n");
    // Close stdin so the server knows no more requests are coming
    // (give it a moment to process the requests first)
    setTimeout(() => {
      child.stdin!.end();
    }, 2000);
  });
}

function parseMcpToolsFromOutput(stdout: string): string[] {
  // stdout may contain multiple JSON-RPC responses, one per line
  const lines = stdout.trim().split("\n");
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.id === 2 && msg.result) {
        const result = msg.result as Record<string, unknown>;
        const tools = result.tools as Array<Record<string, unknown>> | undefined;
        if (tools) {
          return tools.map((t) => (typeof t.name === "string" ? t.name : "unknown"));
        }
      }
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error("No tools/list response found in output");
}

/**
 * Detect the default Codex model from ~/.codex/models_cache.json.
 * Returns the first model slug (which is the default) or undefined.
 */
async function detectCodexDefaultModel(): Promise<string | undefined> {
  try {
    const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    const cacheFile = path.join(codexHome, "models_cache.json");
    const data = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, unknown>;
    const models = data.models as Array<Record<string, unknown>> | undefined;
    const first = models?.[0];
    if (first && typeof first.slug === "string") {
      return first.slug;
    }
  } catch {
    // Cache file missing or malformed — that's fine
  }
  return undefined;
}

export class CodexAgentProvider implements AgentProvider {
  readonly name = "openai" as const;

  async *run(config: AgentProviderConfig): AsyncGenerator<AgentProviderEvent> {
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd",
      config.workspaceDir,
      "--skip-git-repo-check",
    ];

    // Resolve model — use explicit, detect from cache, or leave to Codex default
    const resolvedModel = config.model ?? await detectCodexDefaultModel();
    if (config.model) {
      args.push("--model", config.model);
    }

    // Configure MCP servers via -c flags (highest priority in Codex config).
    //
    // We tried writing .codex/config.toml + overriding CODEX_HOME, but that
    // wipes out Codex's own auth.json (stored in ~/.codex/). The -c flag
    // approach preserves Codex's home dir for auth while injecting MCP config
    // at the highest priority level.
    //
    // Hyphens in server names are replaced with underscores for TOML key compat;
    // we keep a mapping to reconstruct the original name for tool naming.
    const mcpConfigKeyToName = new Map<string, string>();
    let mcpVerifiedTools: string[] = [];

    if (config.mcpServers) {
      for (const [name, server] of Object.entries(config.mcpServers)) {
        const configKey = name.replace(/-/g, "_");
        mcpConfigKeyToName.set(configKey, name);

        // Each field needs its own -c flag with dot notation
        args.push("-c", `mcp_servers.${configKey}.command="${escapeToml(server.command)}"`);
        if (server.args && server.args.length > 0) {
          const argsToml = server.args.map((a) => `"${escapeToml(a)}"`).join(", ");
          args.push("-c", `mcp_servers.${configKey}.args=[${argsToml}]`);
        }
        args.push("-c", `mcp_servers.${configKey}.required=true`);

        if (config.debug) {
          process.stderr.write(`[codex] MCP config for ${name} (key=${configKey}):\n`);
          process.stderr.write(`  command = "${server.command}"\n`);
          if (server.args) process.stderr.write(`  args = [${server.args.join(", ")}]\n`);
          process.stderr.write(`  required = true\n`);
        }
      }

      // Pre-flight: verify each MCP server responds before handing off to Codex
      for (const [name, server] of Object.entries(config.mcpServers)) {
        try {
          const serverArgs = server.args ?? [];
          const serverEnv = { ...config.env, ...(server.env ?? {}) };
          const tools = await verifyMcpServer(server.command, serverArgs, serverEnv);
          mcpVerifiedTools = tools;
          process.stderr.write(
            `[mcp preflight] ${name}: OK — ${tools.length} tools [${tools.join(", ")}]\n`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[mcp preflight] ${name}: FAILED — ${msg}\n`);
        }
      }
    }

    // Build instructions from optional system prompt + MCP tool awareness.
    // Codex presents MCP tools under namespaced names (e.g. docs_mcp__search_docs).
    // Appending verified tool names helps the model discover them — this is
    // analogous to Claude Code listing tools in its own system prompt.
    const parts: string[] = [];
    if (config.systemPrompt) {
      parts.push(config.systemPrompt);
    }
    if (mcpVerifiedTools.length > 0) {
      const toolList = mcpVerifiedTools.map((t) => `- ${t}`).join("\n");
      parts.push(`You have the following documentation tools available via MCP:\n${toolList}\n\nUse these tools to look up API signatures and usage examples — they provide authoritative, pre-indexed SDK documentation that is faster and more reliable than reading source code or searching the web.`);
    }
    if (parts.length > 0) {
      args.push("-c", `instructions="${escapeToml(parts.join("\n\n"))}"`);
    }

    // The prompt is the final positional argument
    args.push(config.prompt);

    // Build spawn environment — pass through config.env but do NOT override
    // CODEX_HOME (Codex needs its own ~/.codex/ for auth.json).
    // In debug mode, enable MCP connection manager diagnostics via RUST_LOG.
    const spawnEnv: Record<string, string> = { ...config.env };
    if (config.debug) {
      const existingRustLog = config.env.RUST_LOG ?? "";
      const mcpLog = "codex_core::mcp_connection_manager=info";
      spawnEnv.RUST_LOG = existingRustLog ? `${existingRustLog},${mcpLog}` : mcpLog;
    }

    // Log the full command being spawned
    const cmdDisplay = ["codex", ...args].map(shellQuote).join(" ");
    if (config.debug) {
      process.stderr.write(`\n[codex] spawning: ${cmdDisplay}\n\n`);
    }

    // Emit init event — include pre-flight verified tools
    const initTools: string[] = config.allowedTools ? [...config.allowedTools] : [];
    const initMcpServers = config.mcpServers
      ? Object.keys(config.mcpServers).map((name) => ({
          name,
          status: mcpVerifiedTools.length > 0 ? `verified (${mcpVerifiedTools.length} tools)` : "configured",
        }))
      : [];
    yield {
      type: "init",
      model: resolvedModel ?? "codex (unknown)",
      tools: initTools,
      mcpServers: initMcpServers,
    };

    // Accumulate usage across turns
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedInputTokens = 0;
    let numTurns = 0;
    const errors: string[] = [];
    let lastAnswer = "";
    let toolIdCounter = 0;
    let sawMcpToolCall = false;

    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
    });

    // Capture stderr — forward in real-time when debug is on
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (config.debug) {
        process.stderr.write(`[codex stderr] ${text}`);
      }
    });

    const rl = createInterface({ input: child.stdout! });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          if (config.debug) {
            process.stderr.write(`[codex stdout] (non-JSON) ${line.slice(0, 200)}\n`);
          }
          continue; // skip malformed lines
        }

        // Structured debug logging — show event type + key fields, not raw JSON
        if (config.debug) {
          process.stderr.write(`[codex] ${summarizeEvent(event)}\n`);
        }

        const eventType = event.type as string | undefined;

        if (eventType === "item.completed") {
          const item = event.item as Record<string, unknown> | undefined;
          if (!item) continue;

          const itemType = item.type as string | undefined;

          if (itemType === "agent_message") {
            // Extract text from content blocks
            const content = item.content as
              | Array<Record<string, unknown>>
              | undefined;
            if (content) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  lastAnswer = block.text;
                  yield { type: "text", text: block.text };
                }
              }
            }
          } else if (itemType === "mcp_tool_call") {
            // Codex MCP events use separate "server" and "tool" fields.
            // Output lives in "result.content", not "output".
            sawMcpToolCall = true;
            const toolId = `codex-tool-${++toolIdCounter}`;

            const serverKey = typeof item.server === "string" ? item.server : "";
            const rawTool = typeof item.tool === "string" ? item.tool : "mcp_tool";

            // Map config key (underscored) back to original name (hyphenated)
            const serverName = mcpConfigKeyToName.get(serverKey) ?? serverKey;
            const toolName = serverName ? `mcp__${serverName}__${rawTool}` : rawTool;

            const toolArgs =
              item.arguments != null && typeof item.arguments === "object"
                ? (item.arguments as Record<string, unknown>)
                : typeof item.arguments === "string"
                  ? safeParseJson(item.arguments)
                  : {};

            const toolOutput = extractMcpToolOutput(item.result);

            yield { type: "tool_call", id: toolId, name: toolName, args: toolArgs };
            yield { type: "tool_result", id: toolId, result: toolOutput };
          } else if (itemType === "command_execution") {
            const toolId = `codex-tool-${++toolIdCounter}`;
            const command =
              typeof item.command === "string"
                ? item.command
                : JSON.stringify(item.command ?? "");
            // Codex uses "aggregated_output" for command results
            const output =
              typeof item.aggregated_output === "string"
                ? item.aggregated_output
                : typeof item.output === "string"
                  ? item.output
                  : JSON.stringify(item.output ?? item.aggregated_output ?? "");

            yield {
              type: "tool_call",
              id: toolId,
              name: "Bash",
              args: { command },
            };
            yield { type: "tool_result", id: toolId, result: output };
          } else if (itemType === "web_search") {
            const toolId = `codex-tool-${++toolIdCounter}`;
            const query =
              typeof item.query === "string" ? item.query : "web search";
            yield {
              type: "tool_call",
              id: toolId,
              name: "WebSearch",
              args: { query },
            };
            yield { type: "tool_result", id: toolId, result: "(web search result)" };
          } else if (itemType === "file_changes") {
            const changes = item.changes as
              | Array<Record<string, unknown>>
              | undefined;
            if (changes) {
              for (const change of changes) {
                const toolId = `codex-tool-${++toolIdCounter}`;
                const filePath =
                  typeof change.file === "string" ? change.file : "unknown";
                const changeType = change.type as string | undefined;
                const toolName =
                  changeType === "create" || changeType === "full_rewrite"
                    ? "Write"
                    : "Edit";
                const content =
                  typeof change.content === "string"
                    ? change.content
                    : typeof change.patch === "string"
                      ? change.patch
                      : JSON.stringify(change);

                yield {
                  type: "tool_call",
                  id: toolId,
                  name: toolName,
                  args: { file_path: filePath },
                };
                yield { type: "tool_result", id: toolId, result: content };
              }
            }
          }
        } else if (eventType === "turn.completed") {
          numTurns++;

          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            totalInputTokens += usage.input_tokens ?? 0;
            totalOutputTokens += usage.output_tokens ?? 0;
            totalCachedInputTokens += usage.cached_input_tokens ?? 0;
          }

          // Enforce maxTurns externally
          if (numTurns >= config.maxTurns) {
            child.kill("SIGTERM");
            break;
          }
        } else if (eventType === "turn.failed" || eventType === "error") {
          const msg =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
                ? event.error
                : JSON.stringify(event);
          errors.push(msg);

          // Surface errors immediately so they show up in the observer stream
          yield {
            type: "text",
            text: `[codex error] ${msg}`,
          };
        }
      }
    } finally {
      // Ensure cleanup
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      // If already exited, resolve immediately
      if (child.exitCode !== null) resolve();
    });

    if (stderrBuf.trim() && errors.length === 0) {
      // Only add stderr as error if we didn't get structured errors
      const stderrLines = stderrBuf.trim().split("\n");
      const errorLines = stderrLines.filter(
        (l) =>
          l.toLowerCase().includes("error") ||
          l.toLowerCase().includes("fatal"),
      );
      if (errorLines.length > 0) {
        errors.push(...errorLines);
      }
    }

    // Warn if MCP tools were verified but never called by the model
    if (mcpVerifiedTools.length > 0 && !sawMcpToolCall) {
      process.stderr.write(
        `[codex] Warning: MCP server had ${mcpVerifiedTools.length} tools available but the model made 0 MCP tool calls.\n`,
      );
    }

    const totalCostUsd = estimateCost(
      resolvedModel,
      totalInputTokens,
      totalOutputTokens,
    );

    const usage: RunUsage = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadInputTokens: totalCachedInputTokens,
      cacheCreationInputTokens: 0,
      totalCostUsd,
      durationApiMs: 0, // not available from Codex CLI
      numTurns,
    };

    yield {
      type: "done",
      subtype: errors.length > 0 ? "error" : "success",
      answer: lastAnswer,
      errors,
      usage,
    };
  }
}

/** Escape a string value for TOML (basic string with double quotes). */
function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return { raw: str };
  }
}

/** Produce a concise one-liner for a Codex NDJSON event (for debug logging). */
function summarizeEvent(event: Record<string, unknown>): string {
  const type = event.type as string;
  const item = event.item as Record<string, unknown> | undefined;

  if (type === "item.completed" && item) {
    const itemType = item.type as string;
    if (itemType === "agent_message") {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      const text = content?.find((b) => b.type === "text")?.text;
      const preview = typeof text === "string" ? text.slice(0, 100) : "";
      return `item.completed/agent_message: "${preview}${typeof text === "string" && text.length > 100 ? "…" : ""}"`;
    }
    if (itemType === "mcp_tool_call") {
      return `item.completed/mcp_tool_call: server=${item.server} tool=${item.tool} status=${item.status}`;
    }
    if (itemType === "command_execution") {
      const cmd = typeof item.command === "string" ? item.command.slice(0, 120) : "";
      const outLen = typeof item.aggregated_output === "string" ? item.aggregated_output.length : 0;
      return `item.completed/command_execution: "${cmd}${cmd.length >= 120 ? "…" : ""}" -> ${outLen} chars`;
    }
    if (itemType === "web_search") {
      const query = typeof item.query === "string" ? item.query.slice(0, 80) : "";
      return `item.completed/web_search: "${query}"`;
    }
    if (itemType === "file_changes") {
      const changes = item.changes as Array<Record<string, unknown>> | undefined;
      const files = changes?.map((ch) => `${ch.type}:${ch.file}`).join(", ") ?? "";
      return `item.completed/file_changes: [${files}]`;
    }
    return `item.completed/${itemType}`;
  }

  if (type === "turn.completed") {
    const usage = event.usage as Record<string, number> | undefined;
    if (usage) {
      return `turn.completed: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}`;
    }
    return "turn.completed";
  }

  if (type === "turn.failed" || type === "error") {
    const msg = event.message ?? event.error ?? "";
    return `${type}: ${String(msg).slice(0, 200)}`;
  }

  // Fallback for other event types (turn.started, item.started, etc.)
  return `${type}${item ? `/${item.type}` : ""}`;
}
