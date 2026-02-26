import { highlight, supportsLanguage } from "cli-highlight";
import type {
  AgentEvalObserver,
  AgentEvalOutput,
  AgentObservedMessage,
  AgentScenario,
  AgentScenarioResult
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
  bgRed: useColor ? "\x1b[41m" : ""
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
  mcp__docs_mcp__get_doc: c.magenta
};

function toolColor(name: string): string {
  if (TOOL_COLORS[name]) return TOOL_COLORS[name]!;
  if (name.startsWith("mcp__")) return c.magenta;
  return c.white;
}

// ── Box-drawing helpers ────────────────────────────────────────────────

function panel(content: string, title?: string, border = c.dim): string {
  const lines = content.split("\n");
  const maxLen = Math.max(...lines.map(stripAnsi).map((l) => l.length), title ? stripAnsi(title).length + 4 : 0);
  const width = Math.min(maxLen + 2, 80);

  const top = title
    ? `${border}╭─ ${c.reset}${title}${border} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 4))}╮${c.reset}`
    : `${border}╭${"─".repeat(width)}╮${c.reset}`;
  const bot = `${border}╰${"─".repeat(width)}╯${c.reset}`;

  const innerWidth = width - 2; // usable chars between "│ " and " │"
  const body = lines.map((line) => {
    const visible = stripAnsi(line);
    let display = line;
    if (visible.length > innerWidth) {
      // Truncate to innerWidth - 1 chars + ellipsis
      display = truncateAnsi(line, innerWidth - 1) + "…";
    }
    const pad = Math.max(1, width - stripAnsi(display).length);
    return `${border}│${c.reset} ${display}${" ".repeat(pad - 1)}${border}│${c.reset}`;
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

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
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
  return text.split("\n").map((l) => pad + l).join("\n");
}

function formatToolResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw);

    // Content block array: [{"type":"text","text":"..."}]
    // Extract the inner text and re-parse it
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type === "text" && typeof parsed[0]?.text === "string") {
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
      } catch { /* fall through */ }
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

// ── Observer config ────────────────────────────────────────────────────

export interface ConsoleObserverOptions {
  model?: string;
  suite?: string;
  debug?: boolean;
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
      ...(this.opts.debug ? [`${c.yellow}Debug mode: streaming agent events${c.reset}`] : [])
    ];

    write("\n" + panel(lines.join("\n"), `${c.cyan}docs-mcp eval${c.reset}`) + "\n");
  }

  onScenarioStart(scenario: AgentScenario, index: number, total: number): void {
    this.showHeader(total);

    write(`\n${c.bold}${c.cyan}━━━ Scenario ${index + 1}/${total}: ${scenario.name} ━━━${c.reset}\n`);
    if (scenario.category) {
      write(`${c.dim}Category: ${scenario.category}${c.reset}\n`);
    }
    write(`${c.white}${scenario.prompt}${c.reset}\n`);
  }

  onAgentMessage(_scenario: AgentScenario, message: AgentObservedMessage): void {
    const ts = `${c.dim}[${(message.timestampMs / 1000).toFixed(1)}s]${c.reset}`;

    switch (message.type) {
      case "system_init":
        write(`${ts} ${c.blue}▶ ${message.summary}${c.reset}\n`);
        break;

      case "assistant_text":
        write(`${ts} ${c.green}◆${c.reset} ${message.summary}\n`);
        break;

      case "tool_call": {
        // Extract tool name from summary: "toolName(args...)"
        const toolName = message.summary.split("(")[0] ?? message.summary;
        const color = toolColor(toolName);
        write(`${ts} ${color}▸ ${toolName}${c.reset}\n`);

        // Show args in a panel (indented)
        if (message.toolArgs && Object.keys(message.toolArgs).length > 0) {
          const argsStr = formatToolArgs(message.toolArgs);
          write(indent(panel(argsStr, undefined, color), 6) + "\n");
        }
        break;
      }

      case "tool_result": {
        const preview = message.toolResultPreview ?? message.summary;
        const formatted = formatToolResult(preview);
        if (formatted.includes("\n")) {
          write(`${ts} ${c.dim}  ↳ result${c.reset}\n`);
          write(indent(panel(formatted, undefined, c.dim), 6) + "\n");
        } else {
          write(`${ts} ${c.dim}  ↳ ${formatted}${c.reset}\n`);
        }
        break;
      }

      case "result":
        write(`${ts} ${c.bold}■ ${message.summary}${c.reset}\n`);
        break;
    }
  }

  onScenarioComplete(_scenario: AgentScenario, result: AgentScenarioResult): void {
    // One-liner summary (skills/evals style)
    const status = result.passed
      ? `${c.bold}${c.green}PASSED${c.reset}`
      : `${c.bold}${c.red}FAILED${c.reset}`;
    const mcp = result.activated
      ? `${c.green}MCP ✓${c.reset}`
      : `${c.yellow}MCP ✗${c.reset}`;

    const parts = [
      `${status} ${c.bold}${result.name}${c.reset}`,
      mcp,
      `${c.dim}$${result.totalCostUsd.toFixed(2)}${c.reset}`,
      `${c.dim}${result.numTurns} turns${c.reset}`,
      `${c.dim}${(result.durationMs / 1000).toFixed(1)}s${c.reset}`
    ];
    write(`\n${parts.join(` ${c.dim}|${c.reset} `)}\n`);

    // Assertion details
    for (const ar of result.assertionResults) {
      const icon = ar.passed ? `${c.green}✓` : `${c.red}✗`;
      write(`  ${icon} ${ar.message}${c.reset}\n`);
    }

    if (result.errors?.length) {
      for (const e of result.errors) {
        write(`  ${c.red}⚠ ${e}${c.reset}\n`);
      }
    }

    // Code snippet with syntax highlighting
    const snippet = extractCodeSnippet(result.finalAnswer);
    if (snippet) {
      const label = snippet.truncated ? "Code (excerpt)" : "Code";
      const header = label + (snippet.lang ? ` [${snippet.lang}]` : "");
      const highlighted = highlightCode(snippet.lines.join("\n"), snippet.lang);
      write("\n" + panel(highlighted, `${c.dim}${header}${c.reset}`, c.dim) + "\n");
    }
  }

  onEvalComplete(output: AgentEvalOutput): void {
    const { results, summary: s } = output;

    // ── Scenario results table ──────────────────────────────────────
    write(`\n${c.bold}${c.cyan}━━━ Results ━━━${c.reset}\n\n`);

    const nameW = Math.max(8, ...results.map((r) => r.name.length));
    const header = `  ${padRight("Scenario", nameW)}  Result    MCP  Turns  Cost      Duration`;
    const sep = `  ${"─".repeat(stripAnsi(header).length - 2)}`;

    write(`${c.bold}${header}${c.reset}\n`);
    write(`${c.dim}${sep}${c.reset}\n`);

    for (const r of results) {
      const result = r.passed
        ? `${c.green}✓ PASS${c.reset}`
        : `${c.red}✗ FAIL${c.reset}`;
      const mcp = r.activated
        ? `${c.green}✓${c.reset}`
        : `${c.yellow}✗${c.reset}`;
      const turns = String(r.numTurns);
      const cost = `$${r.totalCostUsd.toFixed(4)}`;
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;

      write(
        `  ${padRight(r.name, nameW)}  ${padRight(result, 8)}  ${padRight(mcp, 3)}  ${padRight(turns, 5)}  ${padRight(cost, 8)}  ${dur}\n`
      );
    }

    // ── Summary panel ───────────────────────────────────────────────
    const activationColor = s.activationRate >= 0.8 ? c.green : s.activationRate >= 0.5 ? c.yellow : c.red;
    const passColor = s.passRate >= 0.8 ? c.green : s.passRate >= 0.5 ? c.yellow : c.red;

    const summaryLines = [
      `${padRight("Scenarios", 16)}${s.totalScenarios}`,
      `${padRight("Pass rate", 16)}${passColor}${(s.passRate * 100).toFixed(1)}%${c.reset}`,
      `${padRight("Activation", 16)}${activationColor}${(s.activationRate * 100).toFixed(1)}%${c.reset}`,
      `${padRight("Avg turns", 16)}${s.avgTurns.toFixed(1)} ${c.dim}(median ${s.medianTurns})${c.reset}`,
      `${padRight("Avg cost", 16)}$${s.avgCostUsd.toFixed(4)} ${c.dim}(total $${s.totalCostUsd.toFixed(4)})${c.reset}`,
      `${padRight("Avg duration", 16)}${(s.avgDurationMs / 1000).toFixed(1)}s ${c.dim}(median ${(s.medianDurationMs / 1000).toFixed(1)}s)${c.reset}`,
      `${padRight("Avg tokens", 16)}${s.avgInputTokens.toFixed(0)}in / ${s.avgOutputTokens.toFixed(0)}out`
    ];

    write("\n" + panel(summaryLines.join("\n"), `${c.cyan}Summary${c.reset}`) + "\n");

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

// ── Code snippet extraction ────────────────────────────────────────────

const MAX_SNIPPET_LINES = 20;

function extractCodeSnippet(text: string): { lines: string[]; lang?: string; truncated: boolean } | null {
  if (!text || text.length < 10) return null;

  const fenceMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
  if (fenceMatch) {
    const lang = fenceMatch[1] || undefined;
    const codeLines = fenceMatch[2]!.trimEnd().split("\n");
    if (codeLines.length <= MAX_SNIPPET_LINES) {
      return { lines: codeLines, ...(lang ? { lang } : {}), truncated: false };
    }
    return {
      lines: [...codeLines.slice(0, MAX_SNIPPET_LINES), `... (${codeLines.length - MAX_SNIPPET_LINES} more lines)`],
      ...(lang ? { lang } : {}),
      truncated: true
    };
  }

  const allLines = text.trimEnd().split("\n");
  if (allLines.length <= 3) return null;
  const excerptLines = allLines.slice(0, Math.min(8, allLines.length));
  return {
    lines: allLines.length > 8
      ? [...excerptLines, `... (${allLines.length - 8} more lines)`]
      : excerptLines,
    truncated: allLines.length > 8
  };
}

// ── Syntax highlighting (cli-highlight) ────────────────────────────────

function highlightCode(code: string, lang?: string): string {
  if (!useColor) return code;
  try {
    const options = lang && supportsLanguage(lang)
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
