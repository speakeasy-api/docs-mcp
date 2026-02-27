import { describe, expect, it } from "vitest";
import { computeAgentEvalSummary } from "../../src/agent/metrics.js";
import type { AgentScenarioResult } from "../../src/agent/types.js";

function makeResult(overrides: Partial<AgentScenarioResult> = {}): AgentScenarioResult {
  return {
    name: "test",
    activated: true,
    passed: true,
    assertionResults: [],
    numTurns: 5,
    totalCostUsd: 0.1,
    durationMs: 10000,
    durationApiMs: 8000,
    toolsCalled: { search_docs: 2, get_doc: 1 },
    toolCallTrace: [],
    inputTokens: 5000,
    outputTokens: 1000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    mcpToolCalls: 0,
    mcpToolResultChars: 0,
    workspaceFiles: [],
    finalAnswer: "done",
    resultSubtype: "success",
    ...overrides,
  };
}

describe("computeAgentEvalSummary", () => {
  it("returns empty summary for no results", () => {
    const summary = computeAgentEvalSummary([]);
    expect(summary.totalScenarios).toBe(0);
    expect(summary.passRate).toBe(0);
    expect(summary.activationRate).toBe(0);
  });

  it("computes rates correctly", () => {
    const results = [
      makeResult({ activated: true, passed: true }),
      makeResult({ activated: true, passed: false }),
      makeResult({ activated: false, passed: false }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.totalScenarios).toBe(3);
    expect(summary.activationRate).toBeCloseTo(2 / 3, 5);
    expect(summary.passRate).toBeCloseTo(1 / 3, 5);
  });

  it("computes averages and medians", () => {
    const results = [
      makeResult({ numTurns: 3, totalCostUsd: 0.05, durationMs: 5000 }),
      makeResult({ numTurns: 7, totalCostUsd: 0.15, durationMs: 15000 }),
      makeResult({ numTurns: 5, totalCostUsd: 0.1, durationMs: 10000 }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.avgTurns).toBe(5);
    expect(summary.medianTurns).toBe(5);
    expect(summary.avgCostUsd).toBeCloseTo(0.1, 5);
    expect(summary.totalCostUsd).toBeCloseTo(0.3, 5);
    expect(summary.medianDurationMs).toBe(10000);
  });

  it("aggregates tool usage distribution", () => {
    const results = [
      makeResult({ toolsCalled: { search_docs: 3, Read: 1 } }),
      makeResult({ toolsCalled: { search_docs: 2, Write: 1 } }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.toolUsageDistribution.search_docs).toBe(5);
    expect(summary.toolUsageDistribution.Read).toBe(1);
    expect(summary.toolUsageDistribution.Write).toBe(1);
  });

  it("computes category breakdown", () => {
    const results = [
      makeResult({
        category: "sdk-usage",
        passed: true,
        activated: true,
        numTurns: 4,
      }),
      makeResult({
        category: "sdk-usage",
        passed: false,
        activated: true,
        numTurns: 6,
      }),
      makeResult({
        category: "error-handling",
        passed: true,
        activated: false,
        numTurns: 3,
      }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.categoryBreakdown).toHaveLength(2);

    const sdkCat = summary.categoryBreakdown.find((c) => c.category === "sdk-usage");
    expect(sdkCat?.scenarioCount).toBe(2);
    expect(sdkCat?.passRate).toBeCloseTo(0.5, 5);
    expect(sdkCat?.activationRate).toBe(1);
    expect(sdkCat?.avgTurns).toBe(5);

    const errCat = summary.categoryBreakdown.find((c) => c.category === "error-handling");
    expect(errCat?.scenarioCount).toBe(1);
    expect(errCat?.passRate).toBe(1);
    expect(errCat?.activationRate).toBe(0);
  });

  it("computes token averages", () => {
    const results = [
      makeResult({ inputTokens: 4000, outputTokens: 800 }),
      makeResult({ inputTokens: 6000, outputTokens: 1200 }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.avgInputTokens).toBe(5000);
    expect(summary.avgOutputTokens).toBe(1000);
  });

  it("handles median with even number of results", () => {
    const results = [
      makeResult({ numTurns: 2, durationMs: 3000 }),
      makeResult({ numTurns: 8, durationMs: 9000 }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.medianTurns).toBe(5);
    expect(summary.medianDurationMs).toBe(6000);
  });

  it("aggregates MCP tool usage distribution", () => {
    const results = [
      makeResult({
        toolsCalled: {
          "mcp__docs-mcp__search_docs": 3,
          "mcp__docs-mcp__get_doc": 1,
          Read: 2,
        },
        mcpToolCalls: 4,
      }),
      makeResult({
        toolsCalled: { "mcp__docs-mcp__search_docs": 1, Write: 1 },
        mcpToolCalls: 1,
      }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.avgMcpToolCalls).toBe(2.5);
    expect(summary.mcpToolUsageDistribution).toEqual({
      "mcp__docs-mcp__search_docs": 4,
      "mcp__docs-mcp__get_doc": 1,
    });
    // Non-MCP tools should not appear in mcpToolUsageDistribution
    expect(summary.mcpToolUsageDistribution.Read).toBeUndefined();
  });

  it("computes cache token averages", () => {
    const results = [
      makeResult({
        cacheReadInputTokens: 10000,
        cacheCreationInputTokens: 400,
      }),
      makeResult({
        cacheReadInputTokens: 14000,
        cacheCreationInputTokens: 600,
      }),
    ];
    const summary = computeAgentEvalSummary(results);
    expect(summary.avgCacheReadInputTokens).toBe(12000);
    expect(summary.avgCacheCreationInputTokens).toBe(500);
  });

  it("defaults new fields to zero for empty results", () => {
    const summary = computeAgentEvalSummary([]);
    expect(summary.avgMcpToolCalls).toBe(0);
    expect(summary.avgCacheReadInputTokens).toBe(0);
    expect(summary.avgCacheCreationInputTokens).toBe(0);
    expect(summary.mcpToolUsageDistribution).toEqual({});
  });
});
