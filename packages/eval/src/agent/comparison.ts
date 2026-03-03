import type {
  AgentAssertion,
  AgentEvalOutput,
  AssertionResult,
  ComparisonOutput,
  ComparisonSummaryDelta,
  ScenarioComparisonResult,
} from "./types.js";

// ── ANSI color support (mirrors observer.ts) ──────────────────────────

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
};

/**
 * Pair results from a with-MCP run and a without-MCP run by scenario ID,
 * compute deltas, and classify each scenario.
 */
export function buildComparison(
  withMcp: AgentEvalOutput,
  withoutMcp: AgentEvalOutput,
  suite: string,
): ComparisonOutput {
  const withoutById = new Map(withoutMcp.results.map((r) => [r.id, r]));

  const scenarios: ScenarioComparisonResult[] = [];
  for (const w of withMcp.results) {
    const wo = withoutById.get(w.id);
    if (!wo) continue;

    let outcome: ScenarioComparisonResult["outcome"];
    if (w.passed && !wo.passed) outcome = "gained";
    else if (!w.passed && wo.passed) outcome = "lost";
    else if (w.passed && wo.passed) outcome = "both_pass";
    else outcome = "both_fail";

    scenarios.push({
      id: w.id,
      name: w.name,
      ...(w.category !== undefined ? { category: w.category } : {}),
      outcome,
      withMcp: {
        passed: w.passed,
        numTurns: w.numTurns,
        totalCostUsd: w.totalCostUsd,
        durationMs: w.durationMs,
        mcpToolCalls: w.mcpToolCalls,
        assertionResults: w.assertionResults,
      },
      withoutMcp: {
        passed: wo.passed,
        numTurns: wo.numTurns,
        totalCostUsd: wo.totalCostUsd,
        durationMs: wo.durationMs,
        assertionResults: wo.assertionResults,
      },
    });
  }

  const delta: ComparisonSummaryDelta = {
    passRateDelta: withMcp.summary.passRate - withoutMcp.summary.passRate,
    avgTurnsDelta: withMcp.summary.avgTurns - withoutMcp.summary.avgTurns,
    avgCostUsdDelta: withMcp.summary.avgCostUsd - withoutMcp.summary.avgCostUsd,
    totalCostUsdDelta: withMcp.summary.totalCostUsd - withoutMcp.summary.totalCostUsd,
    avgDurationMsDelta: withMcp.summary.avgDurationMs - withoutMcp.summary.avgDurationMs,
    ...(withMcp.summary.avgConfidenceScore !== undefined && withoutMcp.summary.avgConfidenceScore !== undefined
      ? { avgConfidenceScoreDelta: withMcp.summary.avgConfidenceScore - withoutMcp.summary.avgConfidenceScore }
      : {}),
  };

  const startedAt = withMcp.metadata.startedAt < withoutMcp.metadata.startedAt
    ? withMcp.metadata.startedAt
    : withoutMcp.metadata.startedAt;
  const completedAt = withMcp.metadata.completedAt > withoutMcp.metadata.completedAt
    ? withMcp.metadata.completedAt
    : withoutMcp.metadata.completedAt;

  return {
    withMcp,
    withoutMcp,
    delta,
    scenarios,
    metadata: {
      model: withMcp.metadata.model,
      suite,
      startedAt,
      completedAt,
      totalDurationMs: withMcp.metadata.totalDurationMs + withoutMcp.metadata.totalDurationMs,
    },
  };
}

/**
 * Format a human-readable comparison report with colors and box-drawing.
 */
export function formatComparisonReport(comparison: ComparisonOutput): string {
  const { withMcp, withoutMcp, delta, scenarios, metadata } = comparison;
  const wm = withMcp.summary;
  const wo = withoutMcp.summary;

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`${c.bold}${c.cyan}━━━ Comparison: With MCP vs Baseline (No MCP) ━━━${c.reset}`);
  lines.push(`${c.dim}Suite: ${metadata.suite} | Model: ${metadata.model} | Duration: ${(metadata.totalDurationMs / 1000).toFixed(1)}s${c.reset}`);

  // ── Summary metrics table ───────────────────────────────────────────
  const metricsLines: string[] = [];
  metricsLines.push(
    `${c.bold}${padRight("Metric", 16)}${padRight("With MCP", 12)}${padRight("No MCP", 12)}Delta${c.reset}`,
  );
  metricsLines.push(`${c.dim}${"─".repeat(56)}${c.reset}`);

  metricsLines.push(
    formatMetricRow("Pass rate", `${(wm.passRate * 100).toFixed(1)}%`, `${(wo.passRate * 100).toFixed(1)}%`, delta.passRateDelta * 100, "%", "higher"),
  );
  metricsLines.push(
    formatMetricRow("Avg turns", wm.avgTurns.toFixed(1), wo.avgTurns.toFixed(1), delta.avgTurnsDelta, "", "lower"),
  );
  metricsLines.push(
    formatMetricRow("Avg cost", `$${wm.avgCostUsd.toFixed(4)}`, `$${wo.avgCostUsd.toFixed(4)}`, delta.avgCostUsdDelta, "", "lower", true),
  );
  metricsLines.push(
    formatMetricRow("Total cost", `$${wm.totalCostUsd.toFixed(4)}`, `$${wo.totalCostUsd.toFixed(4)}`, delta.totalCostUsdDelta, "", "lower", true),
  );
  metricsLines.push(
    formatMetricRow(
      "Avg duration",
      `${(wm.avgDurationMs / 1000).toFixed(1)}s`,
      `${(wo.avgDurationMs / 1000).toFixed(1)}s`,
      delta.avgDurationMsDelta / 1000,
      "s",
      "lower",
    ),
  );
  metricsLines.push(
    `${padRight("MCP calls", 16)}${padRight((wm.avgMcpToolCalls ?? 0).toFixed(1), 12)}${c.dim}—${c.reset}`,
  );

  if (wm.avgConfidenceScore !== undefined) {
    const withFb = wm.avgConfidenceScore.toFixed(0);
    const woFb = wo.avgConfidenceScore !== undefined ? wo.avgConfidenceScore.toFixed(0) : "—";
    if (delta.avgConfidenceScoreDelta !== undefined) {
      metricsLines.push(
        formatMetricRow("Feedback score", withFb, woFb, delta.avgConfidenceScoreDelta, "", "higher"),
      );
    } else {
      metricsLines.push(
        `${padRight("Feedback score", 16)}${padRight(withFb, 12)}${woFb}`,
      );
    }
  }

  lines.push("");
  lines.push(panel(metricsLines.join("\n"), `${c.cyan}Metrics${c.reset}`));

  // ── Per-scenario table ──────────────────────────────────────────────
  const nameW = Math.max(12, ...scenarios.map((s) => s.id.length));
  const scenarioLines: string[] = [];

  scenarioLines.push(
    `${c.bold}${padRight("Scenario", nameW)}  ${padRight("With MCP", 10)}${padRight("No MCP", 10)}Outcome${c.reset}`,
  );
  scenarioLines.push(`${c.dim}${"─".repeat(nameW + 36)}${c.reset}`);

  for (const s of scenarios) {
    const withStatus = s.withMcp.passed
      ? `${c.green}✓ PASS${c.reset}`
      : `${c.red}✗ FAIL${c.reset}`;
    const withoutStatus = s.withoutMcp.passed
      ? `${c.green}✓ PASS${c.reset}`
      : `${c.red}✗ FAIL${c.reset}`;
    const outcomeStr = formatOutcome(s.outcome);
    scenarioLines.push(
      `${padRight(s.id, nameW)}  ${padRight(withStatus, 10)}${padRight(withoutStatus, 10)}${outcomeStr}`,
    );
  }

  lines.push("");
  lines.push(panel(scenarioLines.join("\n"), `${c.cyan}Scenarios${c.reset}`));

  // ── Outcome summary line ────────────────────────────────────────────
  const gained = scenarios.filter((s) => s.outcome === "gained");
  const lost = scenarios.filter((s) => s.outcome === "lost");
  const bothPass = scenarios.filter((s) => s.outcome === "both_pass");
  const bothFail = scenarios.filter((s) => s.outcome === "both_fail");

  const outcomeparts: string[] = [];
  if (gained.length > 0) outcomeparts.push(`${c.green}▲ gained: ${gained.length}${c.reset}`);
  if (lost.length > 0) outcomeparts.push(`${c.red}▼ lost: ${lost.length}${c.reset}`);
  if (bothPass.length > 0) outcomeparts.push(`${c.dim}─ both pass: ${bothPass.length}${c.reset}`);
  if (bothFail.length > 0) outcomeparts.push(`${c.yellow}─ both fail: ${bothFail.length}${c.reset}`);
  lines.push(`\n  ${outcomeparts.join("  ")}`);

  // ── Gained detail ───────────────────────────────────────────────────
  if (gained.length > 0) {
    const gainedLines: string[] = [];
    for (const s of gained) {
      const mcpCalls = s.withMcp.mcpToolCalls;
      gainedLines.push(`${c.green}✓${c.reset} ${c.bold}${s.id}${c.reset} ${c.dim}— ${mcpCalls} MCP calls${c.reset}`);
      const diffs = diffAssertions(s.withMcp.assertionResults, s.withoutMcp.assertionResults);
      for (const diff of diffs) {
        gainedLines.push(`  ${diff}`);
      }
    }
    lines.push("");
    lines.push(panel(gainedLines.join("\n"), `${c.green}Gained (FAIL → PASS with MCP)${c.reset}`, c.green));
  }

  // ── Lost detail ─────────────────────────────────────────────────────
  if (lost.length > 0) {
    const lostLines: string[] = [];
    for (const s of lost) {
      lostLines.push(`${c.red}✗${c.reset} ${c.bold}${s.id}${c.reset}`);
      const diffs = diffAssertions(s.withMcp.assertionResults, s.withoutMcp.assertionResults);
      for (const diff of diffs) {
        lostLines.push(`  ${diff}`);
      }
    }
    lines.push("");
    lines.push(panel(lostLines.join("\n"), `${c.red}Lost (PASS → FAIL with MCP)${c.reset}`, c.red));
  }

  // ── Both fail detail (with assertion diffs) ─────────────────────────
  if (bothFail.length > 0) {
    const failLines: string[] = [];
    for (const s of bothFail) {
      const diffs = diffAssertions(s.withMcp.assertionResults, s.withoutMcp.assertionResults);
      if (diffs.length > 0) {
        failLines.push(`${c.yellow}─${c.reset} ${c.bold}${s.id}${c.reset} ${c.dim}(assertion diffs)${c.reset}`);
        for (const diff of diffs) {
          failLines.push(`  ${diff}`);
        }
      } else {
        failLines.push(`${c.dim}─ ${s.id}${c.reset}`);
      }
    }
    lines.push("");
    lines.push(panel(failLines.join("\n"), `${c.yellow}Both Fail${c.reset}`, c.yellow));
  }

  lines.push("");
  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatOutcome(outcome: ScenarioComparisonResult["outcome"]): string {
  switch (outcome) {
    case "gained":
      return `${c.green}▲ gained${c.reset}`;
    case "lost":
      return `${c.red}▼ lost${c.reset}`;
    case "both_pass":
      return `${c.dim}─ both pass${c.reset}`;
    case "both_fail":
      return `${c.yellow}─ both fail${c.reset}`;
  }
}

function formatMetricRow(
  label: string,
  withStr: string,
  withoutStr: string,
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
    const arrowColor = isImprovement ? c.green : c.red;
    arrow = ` ${arrowColor}${isImprovement ? "▲" : "▼"}${c.reset}`;
  }

  return `${padRight(label, 16)}${padRight(withStr, 12)}${padRight(withoutStr, 12)}${deltaStr}${arrow}`;
}

// ── Box-drawing ─────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padRight(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  return visible >= width ? str : str + " ".repeat(width - visible);
}

/** Max visible width for comparison panels. */
const PANEL_MAX_WIDTH = 100;

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

function panel(content: string, title?: string, border = c.dim): string {
  // Pre-wrap long lines so content fits the panel
  const wrappedContent = wordWrap(content, PANEL_MAX_WIDTH - 4);
  const contentLines = wrappedContent.split("\n");
  const maxLen = Math.max(
    ...contentLines.map(stripAnsi).map((l) => l.length),
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

  const body = contentLines.map((line) => {
    const pad = Math.max(1, width - stripAnsi(line).length);
    return `${border}│${c.reset} ${line}${" ".repeat(pad - 1)}${border}│${c.reset}`;
  });

  return [top, ...body, bot].join("\n");
}

/**
 * Serialize an assertion to a stable identity key for matching across runs.
 * Uses the assertion shape rather than array index so `when_env` skips don't cause drift.
 */
function assertionKey(a: AgentAssertion): string {
  switch (a.type) {
    case "contains":
      return `contains:${a.value}`;
    case "not_contains":
      return `not_contains:${a.value}`;
    case "matches":
      return `matches:${a.pattern}`;
    case "file_contains":
      return `file_contains:${a.path}:${a.value}`;
    case "file_matches":
      return `file_matches:${a.path}:${a.pattern}`;
    case "script":
      return `script:${a.name}`;
  }
}

/**
 * Compare assertion results between two runs and return human-readable diff lines.
 * Only reports assertions whose pass/fail status changed.
 */
function diffAssertions(
  withMcpResults: AssertionResult[],
  withoutMcpResults: AssertionResult[],
): string[] {
  const withoutByKey = new Map<string, AssertionResult>();
  for (const r of withoutMcpResults) {
    withoutByKey.set(assertionKey(r.assertion), r);
  }

  const diffs: string[] = [];
  for (const wr of withMcpResults) {
    const key = assertionKey(wr.assertion);
    const wor = withoutByKey.get(key);
    if (!wor) continue;
    if (wr.passed !== wor.passed) {
      if (wr.passed) {
        diffs.push(`${c.green}FAIL → PASS${c.reset}${c.dim}: ${wr.message}${c.reset}`);
      } else {
        diffs.push(`${c.red}PASS → FAIL${c.reset}${c.dim}: ${wr.message}${c.reset}`);
      }
    }
  }
  return diffs;
}
