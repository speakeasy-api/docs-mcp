import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvalOutput } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = path.resolve(__dirname, "..", "..", ".eval-results");

/**
 * Save an eval result to disk under `<resultsDir>/<suiteName>/<timestamp>.json`.
 * Returns the absolute path of the saved file.
 */
export async function saveResult(
  output: AgentEvalOutput,
  suiteName: string,
  resultsDir?: string
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
  resultsDir?: string
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
export function generateTrendSummary(
  current: AgentEvalOutput,
  previous: AgentEvalOutput
): string {
  const prev = previous.summary;
  const curr = current.summary;
  const prevDate = previous.metadata.startedAt;

  const lines: string[] = [];
  lines.push(`\n\u2501\u2501\u2501 Trend vs Previous Run (${prevDate}) \u2501\u2501\u2501`);
  lines.push("  Metric          Previous  Current   Delta");
  lines.push("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  // Pass rate — higher is better
  lines.push(formatTrendRow(
    "Pass rate",
    `${(prev.passRate * 100).toFixed(1)}%`,
    `${(curr.passRate * 100).toFixed(1)}%`,
    (curr.passRate - prev.passRate) * 100,
    "%",
    "higher"
  ));

  // Activation — higher is better
  lines.push(formatTrendRow(
    "Activation",
    `${(prev.activationRate * 100).toFixed(1)}%`,
    `${(curr.activationRate * 100).toFixed(1)}%`,
    (curr.activationRate - prev.activationRate) * 100,
    "%",
    "higher"
  ));

  // Avg turns — lower is better
  lines.push(formatTrendRow(
    "Avg turns",
    prev.avgTurns.toFixed(1),
    curr.avgTurns.toFixed(1),
    curr.avgTurns - prev.avgTurns,
    "",
    "lower"
  ));

  // Avg cost — lower is better
  lines.push(formatTrendRow(
    "Avg cost",
    `$${prev.avgCostUsd.toFixed(4)}`,
    `$${curr.avgCostUsd.toFixed(4)}`,
    curr.avgCostUsd - prev.avgCostUsd,
    "",
    "lower",
    true
  ));

  // Total cost — lower is better
  lines.push(formatTrendRow(
    "Total cost",
    `$${prev.totalCostUsd.toFixed(4)}`,
    `$${curr.totalCostUsd.toFixed(4)}`,
    curr.totalCostUsd - prev.totalCostUsd,
    "",
    "lower",
    true
  ));

  // Per-scenario regressions and improvements
  const regressions: string[] = [];
  const improvements: string[] = [];

  const prevByName = new Map(previous.results.map((r) => [r.name, r]));
  for (const curr_r of current.results) {
    const prev_r = prevByName.get(curr_r.name);
    if (!prev_r) continue;
    if (prev_r.passed && !curr_r.passed) {
      regressions.push(`    \u2717 ${curr_r.name} \u2014 was PASS, now FAIL`);
    } else if (!prev_r.passed && curr_r.passed) {
      improvements.push(`    \u2713 ${curr_r.name} \u2014 was FAIL, now PASS`);
    }
  }

  if (regressions.length > 0) {
    lines.push("");
    lines.push("  Regressions:");
    lines.push(...regressions);
  }

  if (improvements.length > 0) {
    lines.push("");
    lines.push("  Improvements:");
    lines.push(...improvements);
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
  isDollar?: boolean
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
    arrow = isImprovement ? " \u25B2" : " \u25BC";
  }

  return `  ${padRight(label, 16)}${padRight(prevStr, 10)}${padRight(currStr, 10)}${deltaStr}${arrow}`;
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function sanitizeSuiteName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
