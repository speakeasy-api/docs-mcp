import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvalOutput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = path.resolve(__dirname, "..", "..", ".eval-results");

// ── ANSI color support (mirrors observer.ts) ──────────────────────────

const useColor = !process.env.NO_COLOR && (process.stderr.isTTY ?? false);

const k = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};

const PANEL_MAX_WIDTH = 100;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function panel(content: string, title?: string, border = k.dim): string {
  const contentLines = content.split("\n");
  const maxLen = Math.max(
    ...contentLines.map(stripAnsi).map((l) => l.length),
    title ? stripAnsi(title).length + 4 : 0,
  );
  const width = Math.min(maxLen + 2, PANEL_MAX_WIDTH);

  const top = title
    ? `${border}╭─ ${k.reset}${title}${border} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 3))}╮${k.reset}`
    : `${border}╭${"─".repeat(width)}╮${k.reset}`;
  const bot = `${border}╰${"─".repeat(width)}╯${k.reset}`;

  const body = contentLines.map((line) => {
    const pad = Math.max(1, width - stripAnsi(line).length);
    return `${border}│${k.reset} ${line}${" ".repeat(pad - 1)}${border}│${k.reset}`;
  });

  return [top, ...body, bot].join("\n");
}

/**
 * Save an eval result to disk under `<resultsDir>/<suiteName>/<timestamp>.json`.
 * Returns the absolute path of the saved file.
 */
export async function saveResult(
  output: AgentEvalOutput,
  suiteName: string,
  resultsDir?: string,
): Promise<string> {
  const dir = path.join(resultsDir ?? DEFAULT_RESULTS_DIR, sanitizeSuiteName(suiteName));
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const filePath = path.join(dir, `${timestamp}.json`);
  await writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`);
  return filePath;
}

/**
 * Load the most recent previous result for a suite.
 * Reads the directory listing, sorts descending, and returns the latest entry.
 * If `excludeAfter` is provided, only results with filenames sorting before it are considered
 * (useful to get the "previous" result when the current one has already been saved).
 */
export async function loadPreviousResult(
  suiteName: string,
  resultsDir?: string,
): Promise<AgentEvalOutput | null> {
  const dir = path.join(resultsDir ?? DEFAULT_RESULTS_DIR, sanitizeSuiteName(suiteName));

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) return null;

  // Most recent file
  const latest = jsonFiles[jsonFiles.length - 1]!;
  const raw = await readFile(path.join(dir, latest), "utf8");
  return JSON.parse(raw) as AgentEvalOutput;
}

/**
 * Generate a trend comparison summary between two eval runs.
 */
export function generateTrendSummary(current: AgentEvalOutput, previous: AgentEvalOutput): string {
  const prev = previous.summary;
  const curr = current.summary;
  const prevDate = previous.metadata.startedAt;

  // ── Metrics table ──────────────────────────────────────────────────
  const metricsLines: string[] = [];
  metricsLines.push(
    `${k.bold}${padRight("Metric", 16)}${padRight("Previous", 12)}${padRight("Current", 12)}Delta${k.reset}`,
  );
  metricsLines.push(`${k.dim}${"─".repeat(56)}${k.reset}`);

  metricsLines.push(
    formatTrendRow("Pass rate", `${(prev.passRate * 100).toFixed(1)}%`, `${(curr.passRate * 100).toFixed(1)}%`, (curr.passRate - prev.passRate) * 100, "%", "higher"),
  );
  metricsLines.push(
    formatTrendRow("Activation", `${(prev.activationRate * 100).toFixed(1)}%`, `${(curr.activationRate * 100).toFixed(1)}%`, (curr.activationRate - prev.activationRate) * 100, "%", "higher"),
  );
  metricsLines.push(
    formatTrendRow("Avg turns", prev.avgTurns.toFixed(1), curr.avgTurns.toFixed(1), curr.avgTurns - prev.avgTurns, "", "lower"),
  );
  metricsLines.push(
    formatTrendRow("Avg cost", `$${prev.avgCostUsd.toFixed(4)}`, `$${curr.avgCostUsd.toFixed(4)}`, curr.avgCostUsd - prev.avgCostUsd, "", "lower", true),
  );
  metricsLines.push(
    formatTrendRow("Total cost", `$${prev.totalCostUsd.toFixed(4)}`, `$${curr.totalCostUsd.toFixed(4)}`, curr.totalCostUsd - prev.totalCostUsd, "", "lower", true),
  );

  const prevMcp = prev.avgMcpToolCalls ?? 0;
  const currMcp = curr.avgMcpToolCalls ?? 0;
  metricsLines.push(
    formatTrendRow("MCP calls", prevMcp.toFixed(1), currMcp.toFixed(1), currMcp - prevMcp, "", "higher"),
  );

  const prevCacheRead = prev.avgCacheReadInputTokens ?? 0;
  const currCacheRead = curr.avgCacheReadInputTokens ?? 0;
  metricsLines.push(
    formatTrendRow("Cache read", Math.round(prevCacheRead).toString(), Math.round(currCacheRead).toString(), currCacheRead - prevCacheRead, "", "higher"),
  );

  const prevCacheCreate = prev.avgCacheCreationInputTokens ?? 0;
  const currCacheCreate = curr.avgCacheCreationInputTokens ?? 0;
  metricsLines.push(
    formatTrendRow("Cache create", Math.round(prevCacheCreate).toString(), Math.round(currCacheCreate).toString(), currCacheCreate - prevCacheCreate, "", "lower"),
  );

  // Feedback metrics
  if (curr.feedbackMetrics) {
    for (const [field, val] of Object.entries(curr.feedbackMetrics)) {
      const prevVal = prev.feedbackMetrics?.[field];
      const prevStr = prevVal !== undefined ? prevVal.toFixed(1) : `${k.dim}—${k.reset}`;
      const delta = prevVal !== undefined ? val - prevVal : 0;
      const hasDelta = prevVal !== undefined;
      if (hasDelta) {
        metricsLines.push(formatTrendRow(`Feedback: ${field}`, prevStr, val.toFixed(1), delta, "", "higher"));
      } else {
        metricsLines.push(`${padRight(`Feedback: ${field}`, 16)}${padRight(prevStr, 12)}${val.toFixed(1)}`);
      }
    }
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${k.bold}${k.cyan}━━━ Trend vs Previous Run ━━━${k.reset}`,
  );
  lines.push(`${k.dim}Previous: ${prevDate}${k.reset}`);
  lines.push("");
  lines.push(panel(metricsLines.join("\n"), `${k.cyan}Metrics${k.reset}`));

  // ── Per-scenario regressions and improvements ─────────────────────
  const regressions: string[] = [];
  const improvements: string[] = [];

  const prevById = new Map(previous.results.map((r) => [r.id ?? r.name, r]));
  for (const curr_r of current.results) {
    const prev_r = prevById.get(curr_r.id ?? curr_r.name);
    if (!prev_r) continue;
    if (prev_r.passed && !curr_r.passed) {
      regressions.push(`${k.red}✗${k.reset} ${k.bold}${curr_r.id}${k.reset} ${k.dim}— was PASS, now FAIL${k.reset}`);
    } else if (!prev_r.passed && curr_r.passed) {
      improvements.push(`${k.green}✓${k.reset} ${k.bold}${curr_r.id}${k.reset} ${k.dim}— was FAIL, now PASS${k.reset}`);
    }
  }

  if (improvements.length > 0) {
    lines.push("");
    lines.push(panel(improvements.join("\n"), `${k.green}Improvements${k.reset}`, k.green));
  }

  if (regressions.length > 0) {
    lines.push("");
    lines.push(panel(regressions.join("\n"), `${k.red}Regressions${k.reset}`, k.red));
  }

  if (improvements.length === 0 && regressions.length === 0) {
    lines.push(`\n  ${k.dim}No scenario status changes${k.reset}`);
  }

  lines.push("");
  return lines.join("\n");
}

function formatTrendRow(
  label: string,
  prevStr: string,
  currStr: string,
  delta: number,
  suffix: string,
  betterDirection: "higher" | "lower",
  isDollar?: boolean,
): string {
  const absDelta = Math.abs(delta);
  let deltaStr: string;
  if (isDollar) {
    deltaStr = `${delta >= 0 ? "+" : "-"}$${absDelta.toFixed(4)}`;
  } else {
    deltaStr = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}${suffix}`;
  }

  let arrow = "";
  if (Math.abs(delta) > 0.001) {
    const isImprovement = betterDirection === "higher" ? delta > 0 : delta < 0;
    const arrowColor = isImprovement ? k.green : k.red;
    arrow = ` ${arrowColor}${isImprovement ? "▲" : "▼"}${k.reset}`;
  }

  return `${padRight(label, 16)}${padRight(prevStr, 12)}${padRight(currStr, 12)}${deltaStr}${arrow}`;
}

function padRight(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  return visible >= width ? str : str + " ".repeat(width - visible);
}

function sanitizeSuiteName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
