import type { EvalSummary, RankedCase } from "./metrics.js";

export interface DeltaCaseData {
  /** Human-readable name for this case */
  name: string;
  /** Whether the expected chunk was found in the top 5 results */
  passed: boolean;
  /** The expected chunk ID for this case */
  expectedChunkId: string;
  /** Ranked chunk IDs returned from search */
  rankedChunkIds: string[];
}

export interface DeltaInput {
  summary: EvalSummary;
  cases: DeltaCaseData[];
}

/**
 * Generate a markdown-formatted delta report comparing current eval run against a baseline.
 *
 * Includes a metrics comparison table and, when case-level data is provided,
 * regression and improvement sections highlighting individual cases that changed.
 */
export function generateDeltaMarkdown(
  current: DeltaInput | EvalSummary,
  baseline: DeltaInput | EvalSummary
): string {
  const currentInput = normalizeDeltaInput(current);
  const baselineInput = normalizeDeltaInput(baseline);

  const currentSummary = normalizeSummary(currentInput.summary);
  const baselineSummary = normalizeSummary(baselineInput.summary);

  const rows = [
    metricRow("MRR@5", baselineSummary.mrrAt5, currentSummary.mrrAt5),
    metricRow("NDCG@5", baselineSummary.ndcgAt5, currentSummary.ndcgAt5),
    metricRow(
      "Avg Rounds to Right Doc",
      baselineSummary.avgRoundsToRightDoc,
      currentSummary.avgRoundsToRightDoc
    ),
    metricRow("Facet Precision", baselineSummary.facetPrecision, currentSummary.facetPrecision),
    metricRow("Search p50 (ms)", baselineSummary.searchP50Ms, currentSummary.searchP50Ms),
    metricRow("Search p95 (ms)", baselineSummary.searchP95Ms, currentSummary.searchP95Ms),
    metricRow("Get Doc p50 (ms)", baselineSummary.getDocP50Ms, currentSummary.getDocP50Ms),
    metricRow("Build Time (ms)", baselineSummary.buildTimeMs, currentSummary.buildTimeMs),
    metricRow("Peak RSS (MB)", baselineSummary.peakRssMb, currentSummary.peakRssMb)
  ];

  const lines = [
    "| Metric | Baseline | Current | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...rows
  ];

  // Regression / improvement tracking requires case-level data on both sides
  if (currentInput.cases.length > 0 && baselineInput.cases.length > 0) {
    const baselineCaseMap = new Map(
      baselineInput.cases.map((c) => [c.name, c])
    );

    const regressions = currentInput.cases.filter((c) => {
      const bc = baselineCaseMap.get(c.name);
      if (!bc) return false;
      return bc.passed && !c.passed;
    });

    const improvements = currentInput.cases.filter((c) => {
      const bc = baselineCaseMap.get(c.name);
      if (!bc) return false;
      return !bc.passed && c.passed;
    });

    if (regressions.length > 0) {
      lines.push("");
      lines.push("### Regressions");
      lines.push("");
      for (const r of regressions) {
        const bc = baselineCaseMap.get(r.name)!;
        const baselineRank = rankLabel(bc);
        const currentRank = rankLabel(r);
        lines.push(
          `- **${r.name}**: was rank ${baselineRank}, now rank ${currentRank}`
        );
      }
    }

    if (improvements.length > 0) {
      lines.push("");
      lines.push("### Improvements");
      lines.push("");
      for (const imp of improvements) {
        const currentRank = rankLabel(imp);
        lines.push(
          `- **${imp.name}**: now found at rank ${currentRank}`
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Build a DeltaCaseData array from RankedCase array, using index-based names
 * when no names are available.
 */
export function toDeltaCases(cases: RankedCase[]): DeltaCaseData[] {
  return cases.map((c, i) => ({
    name: `case-${i}`,
    passed: c.rankedChunkIds.slice(0, 5).includes(c.expectedChunkId),
    expectedChunkId: c.expectedChunkId,
    rankedChunkIds: c.rankedChunkIds
  }));
}

function rankLabel(c: DeltaCaseData): string {
  const idx = c.rankedChunkIds.indexOf(c.expectedChunkId);
  return idx >= 0 ? String(idx + 1) : "N/F";
}

function normalizeDeltaInput(input: DeltaInput | EvalSummary): DeltaInput {
  if ("summary" in input) {
    return input;
  }
  return { summary: input, cases: [] };
}

function metricRow(metric: string, baseline: number, current: number): string {
  const delta = current - baseline;
  const signedDelta = delta >= 0 ? `+${delta.toFixed(6)}` : delta.toFixed(6);
  return `| ${metric} | ${baseline.toFixed(6)} | ${current.toFixed(6)} | ${signedDelta} |`;
}

function normalizeSummary(summary: EvalSummary): EvalSummary {
  return {
    mrrAt5: coerceNumber(summary.mrrAt5),
    ndcgAt5: coerceNumber(summary.ndcgAt5),
    avgRoundsToRightDoc: coerceNumber(summary.avgRoundsToRightDoc),
    facetPrecision: coerceNumber(summary.facetPrecision),
    searchP50Ms: coerceNumber(summary.searchP50Ms),
    searchP95Ms: coerceNumber(summary.searchP95Ms),
    getDocP50Ms: coerceNumber(summary.getDocP50Ms),
    buildTimeMs: coerceNumber(summary.buildTimeMs),
    peakRssMb: coerceNumber(summary.peakRssMb)
  };
}

function coerceNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
