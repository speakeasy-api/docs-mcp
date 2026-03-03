import { highlight, supportsLanguage } from "cli-highlight";
import type {
  AgentEvalObserver,
  AgentEvalOutput,
  AgentObservedMessage,
  AgentScenario,
  AgentScenarioResult,
  FeedbackToolConfig,
} from "./types.js";

const useColor = !process.env.NO_COLOR && (process.stderr.isTTY ?? false);

const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
  white: useColor ? "\x1b[37m" : "",
  bgGreen: useColor ? "\x1b[42m" : "",
  bgRed: useColor ? "\x1b[41m" : "",
};

// ── Tool color mapping (mirrors skills/evals observer.py) ──────────────

const TOOL_COLORS: Record<string, string> = {
  Bash: c.yellow,
  Read: c.blue,
  Write: c.green,
  Edit: c.green,
  Glob: c.cyan,
  Grep: c.cyan,
  mcp__docs_mcp__search_docs: c.magenta,
  mcp__docs_mcp__get_doc: c.magenta,
};

function toolColor(name: string): string {
  if (TOOL_COLORS[name]) return TOOL_COLORS[name]!;
  if (name.startsWith("mcp__")) return c.magenta;
  return c.white;
}

// ── Tool name helpers ──────────────────────────────────────────────────

function cleanToolName(name: string): string {
  return name.replace(/^mcp__docs-mcp__/, "");
}

function formatBarChart(dist: Record<string, number>): string {
  const entries = Object.entries(dist).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return "";

  const maxCount = entries[0]![1];
  const maxNameLen = Math.max(...entries.map(([n]) => cleanToolName(n).length));
  const maxBarWidth = Math.max(1, PANEL_MAX_WIDTH - maxNameLen - 12);

  const lines: string[] = [];
  for (const [name, count] of entries) {
    const clean = cleanToolName(name);
    const barLen = maxCount > 0 ? Math.max(1, Math.round((count / maxCount) * maxBarWidth)) : 1;
    const color = toolColor(name);
    lines.push(
      `${padRight(clean, maxNameLen)}  ${color}${"█".repeat(barLen)}${c.reset} ${c.dim}${count}${c.reset}`,
    );
  }
  return lines.join("\n");
}

// ── Box-drawing helpers ────────────────────────────────────────────────

/** Max visible width for panel boxes. */
const PANEL_MAX_WIDTH = 100;

function panel(content: string, title?: string, border = c.dim): string {
  // Pre-wrap long lines so content fits the panel instead of being truncated
  const wrappedContent = wordWrap(content, PANEL_MAX_WIDTH - 4);
  const lines = wrappedContent.split("\n");
  const maxLen = Math.max(
    ...lines.map(stripAnsi).map((l) => l.length),
    title ? stripAnsi(title).length + 4 : 0,
  );
  const width = Math.min(maxLen + 2, PANEL_MAX_WIDTH);

  // Top border: "╭─ TITLE ───╮" or "╭───────╮"
  // Total visible = 3 + title_len + 1 + dashes + 1 = width + 2
  //   → dashes = width - title_len - 3
  const top = title
    ? `${border}╭─ ${c.reset}${title}${border} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 3))}╮${c.reset}`
    : `${border}╭${"─".repeat(width)}╮${c.reset}`;
  const bot = `${border}╰${"─".repeat(width)}╯${c.reset}`;

  const body = lines.map((line) => {
    const pad = Math.max(1, width - stripAnsi(line).length);
    return `${border}│${c.reset} ${line}${" ".repeat(pad - 1)}${border}│${c.reset}`;
  });

  return [top, ...body, bot].join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────

function write(text: string): void {
  process.stderr.write(text);
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padRight(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  return visible >= width ? str : str + " ".repeat(width - visible);
}

/** Truncate a string that may contain ANSI codes to `max` visible characters. */
function truncateAnsi(str: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\x1b\[[0-9;]*m/g;
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < max) {
    ansiRe.lastIndex = i;
    const m = ansiRe.exec(str);
    if (m && m.index === i) {
      i += m[0].length;
    } else {
      visible++;
      i++;
    }
  }
  return str.slice(0, i);
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Word-wrap plain text to a given column width, preserving existing newlines. */
function wordWrap(text: string, width: number): string {
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (stripAnsi(paragraph).length <= width) {
      result.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (stripAnsi(candidate).length > width && line) {
        result.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) result.push(line);
  }
  return result.join("\n");
}

function formatToolResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw);

    // Content block array: [{"type":"text","text":"..."}]
    // Extract the inner text and re-parse it
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed[0]?.type === "text" &&
      typeof parsed[0]?.text === "string"
    ) {
      const inner = parsed.map((b: { text?: string }) => b.text ?? "").join("\n");
      return formatToolResult(inner); // recurse on the extracted text
    }

    if (typeof parsed === "object" && parsed !== null) {
      const pretty = JSON.stringify(parsed, null, 2);
      return pretty.length > 800 ? pretty.slice(0, 800) + "\n… (truncated)" : pretty;
    }
  } catch {
    // Not valid JSON — try common wrapper patterns
    if (raw.includes("\\n") && (raw.startsWith("{") || raw.startsWith("["))) {
      try {
        const unescaped = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
        return formatToolResult(unescaped);
      } catch {
        /* fall through */
      }
    }
  }
  // Plain text — truncate long single-line results
  return raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
}

function formatToolArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args, null, 2);
    return json.length > 400 ? json.slice(0, 400) + "\n... (truncated)" : json;
  } catch {
    return String(args).slice(0, 400);
  }
}

/** Compact one-liner for tool call args (always shown). */
function formatCompactArgs(args: Record<string, unknown>): string {
  // Pick the most informative arg to show inline
  const key =
    args.query ?? args.file_path ?? args.command ?? args.pattern ?? args.path ?? args.slug;
  if (key && typeof key === "string") {
    const display = key.length > 60 ? key.slice(0, 60) + "…" : key;
    return display;
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const [k, v] = entries[0]!;
  const val = typeof v === "string" ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : JSON.stringify(v);
  return `${k}=${val}`;
}

/** Compact one-liner for tool result (always shown). */
function formatCompactResult(result: string): string {
  if (!result || result === '""') return "(empty)";
  const lines = result.split("\n");
  if (result.length <= 80 && lines.length === 1) return result;
  if (lines.length > 1) return `${lines.length} lines, ${result.length} chars`;
  return `${result.length} chars`;
}

// ── Observer config ────────────────────────────────────────────────────

export interface ConsoleObserverOptions {
  model?: string;
  suite?: string;
  debug?: boolean;
  feedbackToolConfig?: FeedbackToolConfig;
}

// ── Console observer (Rich-style) ──────────────────────────────────────

export class ConsoleObserver implements AgentEvalObserver {
  private headerShown = false;
  private readonly opts: ConsoleObserverOptions;

  constructor(opts?: ConsoleObserverOptions) {
    this.opts = opts ?? {};
  }

  private showHeader(total: number): void {
    if (this.headerShown) return;
    this.headerShown = true;

    const lines = [
      `${c.bold}Agent Eval${c.reset}`,
      ...(this.opts.suite ? [`Suite: ${this.opts.suite}`] : []),
      `Model: ${this.opts.model ?? "default"}`,
      `Scenarios: ${total}`,
      ...(this.opts.debug ? [`${c.yellow}Debug mode: streaming agent events${c.reset}`] : []),
    ];

    write("\n" + panel(lines.join("\n"), `${c.cyan}docs-mcp eval${c.reset}`) + "\n");
  }

  onScenarioStart(scenario: AgentScenario, index: number, total: number): void {
    this.showHeader(total);

    write(
      `\n${c.bold}${c.cyan}━━━ Scenario ${index + 1}/${total}: ${c.reset}${c.dim}[${scenario.id}]${c.reset} ${c.bold}${c.cyan}${scenario.name} ━━━${c.reset}\n`,
    );
    const meta: string[] = [];
    if (scenario.category) meta.push(`Category: ${scenario.category}`);
    if (scenario.models) {
      const modelEntries = Object.entries(scenario.models)
        .map(([p, m]) => `${p}=${m}`)
        .join(", ");
      if (modelEntries) meta.push(`Models: ${modelEntries}`);
    }
    if (meta.length > 0) {
      write(`${c.dim}${meta.join(" | ")}${c.reset}\n`);
    }
    write(`${c.white}${wordWrap(scenario.prompt, PANEL_MAX_WIDTH)}${c.reset}\n`);
  }

  onAgentMessage(_scenario: AgentScenario, message: AgentObservedMessage): void {
    const ts = `${c.dim}[${(message.timestampMs / 1000).toFixed(1)}s]${c.reset}`;
    const debug = this.opts.debug;

    switch (message.type) {
      case "system_init": {
        const initPrefix = `${ts} ${c.blue}▶ `;
        const initPrefixLen = stripAnsi(initPrefix).length;
        const initWrapped = wordWrap(message.summary, Math.max(40, PANEL_MAX_WIDTH - initPrefixLen));
        const initLines = initWrapped.split("\n");
        write(`${initPrefix}${initLines[0]}${c.reset}\n`);
        for (let i = 1; i < initLines.length; i++) {
          write(`${" ".repeat(initPrefixLen)}${c.blue}${initLines[i]}${c.reset}\n`);
        }
        if (message.workspaceDir) {
          write(`${ts} ${c.cyan}${c.bold}  workspace: ${message.workspaceDir}${c.reset}\n`);
        }
        break;
      }

      case "assistant_text": {
        // Show full assistant text with word wrapping
        const text = message.fullText ?? message.summary;
        const prefix = `${ts} ${c.green}◆${c.reset} `;
        const prefixLen = stripAnsi(prefix).length;
        const wrapped = wordWrap(text, Math.max(40, 100 - prefixLen));
        const lines = wrapped.split("\n");
        write(`${prefix}${lines[0]}\n`);
        if (lines.length > 1) {
          const contPad = " ".repeat(prefixLen);
          for (let i = 1; i < lines.length; i++) {
            write(`${contPad}${lines[i]}\n`);
          }
        }
        break;
      }

      case "tool_call": {
        const toolName = message.toolName ?? message.summary.split("(")[0] ?? message.summary;
        const color = toolColor(toolName);
        const compact = message.toolArgs ? formatCompactArgs(message.toolArgs) : "";
        const argDisplay = compact ? `  ${c.dim}${compact}${c.reset}` : "";
        write(`${ts} ${color}▸ ${toolName}${c.reset}${argDisplay}\n`);

        // Show full args panel only in debug mode
        if (debug && message.toolArgs && Object.keys(message.toolArgs).length > 0) {
          const argsStr = formatToolArgs(message.toolArgs);
          write(indent(panel(argsStr, undefined, color), 6) + "\n");
        }
        break;
      }

      case "tool_result": {
        const preview = message.toolResultPreview ?? message.summary;
        if (debug) {
          // Full panel in debug mode
          const formatted = formatToolResult(preview);
          if (formatted.includes("\n")) {
            write(`${ts} ${c.dim}  ↳ result${c.reset}\n`);
            write(indent(panel(formatted, undefined, c.dim), 6) + "\n");
          } else {
            write(`${ts} ${c.dim}  ↳ ${formatted}${c.reset}\n`);
          }
        } else {
          // Compact one-liner in normal mode
          const compact = formatCompactResult(preview);
          write(`${ts} ${c.dim}  ↳ ${compact}${c.reset}\n`);
        }
        break;
      }

      case "result": {
        const resPrefix = `${ts} ${c.bold}■ `;
        const resPrefixLen = stripAnsi(resPrefix).length;
        const resWrapped = wordWrap(message.summary, Math.max(40, PANEL_MAX_WIDTH - resPrefixLen));
        const resLines = resWrapped.split("\n");
        write(`${resPrefix}${resLines[0]}${c.reset}\n`);
        for (let i = 1; i < resLines.length; i++) {
          write(`${" ".repeat(resPrefixLen)}${c.bold}${resLines[i]}${c.reset}\n`);
        }
        break;
      }
    }
  }

  onScenarioComplete(_scenario: AgentScenario, result: AgentScenarioResult): void {
    // One-liner summary (skills/evals style)
    const status = result.passed
      ? `${c.bold}${c.green}PASSED${c.reset}`
      : `${c.bold}${c.red}FAILED${c.reset}`;
    const mcp = result.activated ? `${c.green}MCP ✓${c.reset}` : `${c.yellow}MCP ✗${c.reset}`;

    const parts = [
      `${status} ${c.bold}${result.name}${c.reset}`,
      mcp,
      `${c.dim}$${result.totalCostUsd.toFixed(2)}${c.reset}`,
      `${c.dim}${result.numTurns} turns${c.reset}`,
      `${c.dim}${(result.durationMs / 1000).toFixed(1)}s${c.reset}`,
    ];
    if (result.feedbackResult) {
      const cfg = this.opts.feedbackToolConfig;
      const headlineField = cfg?.headlineField ?? cfg?.metrics[0]?.field;
      const headlineLabel =
        cfg?.metrics.find((m) => m.field === headlineField)?.label ?? "judge";
      const headlineValue = headlineField
        ? result.feedbackResult.scores[headlineField]
        : undefined;
      if (headlineValue !== undefined) {
        parts.push(`${c.cyan}${headlineLabel}: ${headlineValue}${c.reset}`);
      }
    }
    write(`\n${parts.join(` ${c.dim}|${c.reset} `)}\n`);

    // Assertion details
    const assertIndent = 4; // "  ✓ " prefix width
    for (const ar of result.assertionResults) {
      const icon = ar.passed ? `${c.green}✓` : ar.assertion.soft ? `${c.yellow}⚠` : `${c.red}✗`;
      const wrapped = wordWrap(ar.message, PANEL_MAX_WIDTH - assertIndent);
      const msgLines = wrapped.split("\n");
      write(`  ${icon} ${msgLines[0]}${c.reset}\n`);
      for (let i = 1; i < msgLines.length; i++) {
        write(`${" ".repeat(assertIndent)}${msgLines[i]}${c.reset}\n`);
      }
    }

    if (result.errors?.length) {
      for (const e of result.errors) {
        const wrapped = wordWrap(e, PANEL_MAX_WIDTH - assertIndent);
        const errLines = wrapped.split("\n");
        write(`  ${c.red}⚠ ${errLines[0]}${c.reset}\n`);
        for (let i = 1; i < errLines.length; i++) {
          write(`${" ".repeat(assertIndent)}${c.red}${errLines[i]}${c.reset}\n`);
        }
      }
    }

    // Show workspace files written by the agent
    if (result.workspaceFiles?.length) {
      for (const file of result.workspaceFiles) {
        const lines = file.content.split("\n");
        const truncated = lines.length > MAX_SNIPPET_LINES;
        const displayLines = truncated
          ? [
              ...lines.slice(0, MAX_SNIPPET_LINES),
              `... (${lines.length - MAX_SNIPPET_LINES} more lines)`,
            ]
          : lines;
        const header = file.path + (truncated ? " (excerpt)" : "");
        const highlighted = highlightCode(displayLines.join("\n"), file.lang);
        write("\n" + panel(highlighted, `${c.dim}${header}${c.reset}`, c.dim) + "\n");
      }
    }

    // Show workspace directory
    if (result.workspaceDir) {
      write(`\n  ${c.cyan}workspace:${c.reset} ${c.bold}${result.workspaceDir}${c.reset}\n`);
    }
  }

  onEvalComplete(output: AgentEvalOutput): void {
    const { results, summary: s } = output;

    // ── Scenario results table ──────────────────────────────────────
    write(`\n${c.bold}${c.cyan}━━━ Results ━━━${c.reset}\n\n`);

    const nameW = Math.max(10, ...results.map((r) => r.id.length));
    const costW = Math.max(10, ...results.map((r) => `$${r.totalCostUsd.toFixed(4)}`.length));
    const durW = Math.max(10, ...results.map((r) => `${(r.durationMs / 1000).toFixed(1)}s`.length));
    const header = `  ${padRight("Scenario", nameW)}  Result    MCP  Turns  ${padRight("Cost", costW)}  Duration`;
    const sep = `  ${"─".repeat(stripAnsi(header).length - 2)}`;

    write(`${c.bold}${header}${c.reset}\n`);
    write(`${c.dim}${sep}${c.reset}\n`);

    for (const r of results) {
      const result = r.passed ? `${c.green}✓ PASS${c.reset}` : `${c.red}✗ FAIL${c.reset}`;
      const mcp = r.activated ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`;
      const turns = String(r.numTurns);
      const cost = `$${r.totalCostUsd.toFixed(4)}`;
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;

      write(
        `  ${padRight(r.id, nameW)}  ${padRight(result, 8)}  ${padRight(mcp, 3)}  ${padRight(turns, 5)}  ${padRight(cost, costW)}  ${padRight(dur, durW)}\n`,
      );
    }

    // ── Summary panel ───────────────────────────────────────────────
    const activationColor =
      s.activationRate >= 0.8 ? c.green : s.activationRate >= 0.5 ? c.yellow : c.red;
    const passColor = s.passRate >= 0.8 ? c.green : s.passRate >= 0.5 ? c.yellow : c.red;

    const summaryLines = [
      `${padRight("Scenarios", 16)}${s.totalScenarios}`,
      `${padRight("Pass rate", 16)}${passColor}${(s.passRate * 100).toFixed(1)}%${c.reset}`,
      `${padRight("Activation", 16)}${activationColor}${(s.activationRate * 100).toFixed(1)}%${c.reset}`,
      `${padRight("Avg turns", 16)}${s.avgTurns.toFixed(1)} ${c.dim}(median ${s.medianTurns})${c.reset}`,
      `${padRight("Avg cost", 16)}$${s.avgCostUsd.toFixed(4)} ${c.dim}(total $${s.totalCostUsd.toFixed(4)})${c.reset}`,
      `${padRight("Avg duration", 16)}${(s.avgDurationMs / 1000).toFixed(1)}s ${c.dim}(median ${(s.medianDurationMs / 1000).toFixed(1)}s)${c.reset}`,
      `${padRight("Avg tokens", 16)}${s.avgInputTokens.toFixed(0)}in / ${s.avgOutputTokens.toFixed(0)}out${formatCacheTokens(s.avgCacheReadInputTokens, s.avgCacheCreationInputTokens)}`,
      formatMcpCallsLine(s),
      formatFeedbackLine(s),
    ].filter(Boolean);

    write("\n" + panel(summaryLines.join("\n"), `${c.cyan}Summary${c.reset}`) + "\n");

    // Tool usage bar chart
    if (Object.keys(s.toolUsageDistribution).length > 0) {
      const chart = formatBarChart(s.toolUsageDistribution);
      if (chart) {
        write("\n" + panel(chart, `${c.cyan}Tool Usage${c.reset}`) + "\n");
      }
    }

    // Category breakdown
    if (s.categoryBreakdown.length > 0) {
      const catLines = s.categoryBreakdown.map((cat) => {
        const pr = `${(cat.passRate * 100).toFixed(0)}% pass`;
        const ar = `${(cat.activationRate * 100).toFixed(0)}% activation`;
        return `${padRight(cat.category, 16)}${cat.scenarioCount} scenarios, ${pr}, ${ar}`;
      });
      write("\n" + panel(catLines.join("\n"), `${c.cyan}Categories${c.reset}`) + "\n");
    }

    write("\n");
  }
}

// ── Summary line helpers ───────────────────────────────────────────────

function formatCacheTokens(avgRead: number, avgCreate: number): string {
  if (avgRead === 0 && avgCreate === 0) return "";
  return ` ${c.dim}(cache: ${Math.round(avgRead)} read, ${Math.round(avgCreate)} create)${c.reset}`;
}

function formatFeedbackLine(s: import("./types.js").AgentEvalSummary): string {
  if (!s.feedbackMetrics) return "";
  const entries = Object.entries(s.feedbackMetrics);
  if (entries.length === 0) return "";
  const [, firstVal] = entries[0]!;
  const rest = entries
    .slice(1)
    .map(([k, v]) => `${k}: ${v.toFixed(0)}`)
    .join(", ");
  const detail = rest ? ` ${c.dim}(${rest})${c.reset}` : "";
  return `${padRight("Feedback", 16)}${firstVal.toFixed(0)}${detail}`;
}

function formatMcpCallsLine(s: import("./types.js").AgentEvalSummary): string {
  const dist = s.mcpToolUsageDistribution ?? {};
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total === 0) return "";

  const parts = Object.entries(dist)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, count]) => `${tool.replace("mcp__docs-mcp__", "")}: ${count}`)
    .join(", ");

  return `${padRight("MCP calls", 16)}${(s.avgMcpToolCalls ?? 0).toFixed(1)} avg ${c.dim}(${parts})${c.reset}`;
}

// ── Workspace file display ──────────────────────────────────────────────

const MAX_SNIPPET_LINES = 20;

// ── Syntax highlighting (cli-highlight) ────────────────────────────────

function highlightCode(code: string, lang?: string): string {
  if (!useColor) return code;
  try {
    const options =
      lang && supportsLanguage(lang)
        ? { language: lang, ignoreIllegals: true }
        : { ignoreIllegals: true };
    return highlight(code, options);
  } catch {
    return code;
  }
}

// ── Noop observer ──────────────────────────────────────────────────────

export class NoopObserver implements AgentEvalObserver {
  onScenarioStart(): void {}
  onAgentMessage(): void {}
  onScenarioComplete(): void {}
  onEvalComplete(): void {}
}
