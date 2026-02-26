import type { AgentCategoryBreakdown, AgentEvalSummary, AgentScenarioResult } from "./types.js";

export function computeAgentEvalSummary(results: AgentScenarioResult[]): AgentEvalSummary {
  const n = results.length;
  if (n === 0) {
    return emptySummary();
  }

  const activated = results.filter((r) => r.activated).length;
  const passed = results.filter((r) => r.passed).length;

  const turns = results.map((r) => r.numTurns);
  const costs = results.map((r) => r.totalCostUsd);
  const durations = results.map((r) => r.durationMs);
  const inputTokens = results.map((r) => r.inputTokens);
  const outputTokens = results.map((r) => r.outputTokens);

  const toolUsageDistribution: Record<string, number> = {};
  for (const r of results) {
    for (const [tool, count] of Object.entries(r.toolsCalled)) {
      toolUsageDistribution[tool] = (toolUsageDistribution[tool] ?? 0) + count;
    }
  }

  return {
    totalScenarios: n,
    activationRate: round(activated / n),
    passRate: round(passed / n),
    avgTurns: round(avg(turns)),
    medianTurns: median(turns),
    avgCostUsd: round(avg(costs)),
    totalCostUsd: round(sum(costs)),
    avgDurationMs: round(avg(durations)),
    medianDurationMs: round(median(durations)),
    avgInputTokens: round(avg(inputTokens)),
    avgOutputTokens: round(avg(outputTokens)),
    toolUsageDistribution,
    categoryBreakdown: computeCategoryBreakdown(results)
  };
}

function computeCategoryBreakdown(results: AgentScenarioResult[]): AgentCategoryBreakdown[] {
  const groups = new Map<string, AgentScenarioResult[]>();
  for (const r of results) {
    const cat = r.category ?? "uncategorized";
    let group = groups.get(cat);
    if (!group) {
      group = [];
      groups.set(cat, group);
    }
    group.push(r);
  }

  const breakdown: AgentCategoryBreakdown[] = [];
  for (const [category, group] of groups) {
    const n = group.length;
    breakdown.push({
      category,
      scenarioCount: n,
      activationRate: round(group.filter((r) => r.activated).length / n),
      passRate: round(group.filter((r) => r.passed).length / n),
      avgTurns: round(avg(group.map((r) => r.numTurns))),
      avgCostUsd: round(avg(group.map((r) => r.totalCostUsd)))
    });
  }

  return breakdown.sort((a, b) => a.category.localeCompare(b.category));
}

function emptySummary(): AgentEvalSummary {
  return {
    totalScenarios: 0,
    activationRate: 0,
    passRate: 0,
    avgTurns: 0,
    medianTurns: 0,
    avgCostUsd: 0,
    totalCostUsd: 0,
    avgDurationMs: 0,
    medianDurationMs: 0,
    avgInputTokens: 0,
    avgOutputTokens: 0,
    toolUsageDistribution: {},
    categoryBreakdown: []
  };
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return sorted[mid] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
