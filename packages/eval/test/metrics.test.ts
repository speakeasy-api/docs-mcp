import { describe, expect, it } from "vitest";
import {
  generateDeltaMarkdown,
  runEvaluation,
  summarizeCases,
  toDeltaCases,
  type RankedCase,
} from "../src/index.js";

const cases: RankedCase[] = [
  {
    expectedChunkId: "a",
    rankedChunkIds: ["a", "b", "c"],
    roundsToRightDoc: 1,
  },
  {
    expectedChunkId: "b",
    rankedChunkIds: ["c", "b", "a"],
    roundsToRightDoc: 2,
  },
  {
    expectedChunkId: "x",
    rankedChunkIds: ["a", "b", "c"],
    roundsToRightDoc: 4,
  },
];

describe("eval metrics", () => {
  it("computes summary metrics", () => {
    const summary = summarizeCases(cases);

    expect(summary.mrrAt5).toBeCloseTo((1 + 1 / 2 + 0) / 3, 6);
    expect(summary.ndcgAt5).toBeGreaterThan(0);
    expect(summary.avgRoundsToRightDoc).toBeCloseTo((1 + 2 + 4) / 3, 6);
    expect(summary.searchP50Ms).toBe(0);
    expect(summary.searchP95Ms).toBe(0);
    expect(summary.getDocP50Ms).toBe(0);
    expect(summary.buildTimeMs).toBe(0);
    expect(summary.peakRssMb).toBe(0);
  });

  it("computes facetPrecision as fraction of cases with expected chunk in top 5", () => {
    const summary = summarizeCases(cases);

    // "a" is in top 5 of ["a","b","c"] -> found
    // "b" is in top 5 of ["c","b","a"] -> found
    // "x" is NOT in ["a","b","c"] -> not found
    expect(summary.facetPrecision).toBeCloseTo(2 / 3, 6);
  });

  it("produces deterministic runner metadata", () => {
    const run = runEvaluation({
      cases,
      deterministic: true,
      model: {
        provider: "openai",
        model: "text-embedding-3-large",
      },
    });

    expect(run.metadata.deterministic).toBe(true);
    expect(run.metadata.provider).toBe("openai");
  });

  it("includes latency percentiles when timing samples are provided", () => {
    const summary = summarizeCases(cases, {
      searchLatenciesMs: [5, 10, 20, 40],
      getDocLatenciesMs: [2, 3, 9],
      buildTimeMs: 1234,
      peakRssMb: 88.5,
    });

    expect(summary.searchP50Ms).toBe(10);
    expect(summary.searchP95Ms).toBe(40);
    expect(summary.getDocP50Ms).toBe(3);
    expect(summary.buildTimeMs).toBe(1234);
    expect(summary.peakRssMb).toBe(88.5);
  });

  it("generates markdown deltas", () => {
    const markdown = generateDeltaMarkdown(
      {
        mrrAt5: 0.5,
        ndcgAt5: 0.6,
        avgRoundsToRightDoc: 2.2,
        facetPrecision: 0.75,
        searchP50Ms: 10,
        searchP95Ms: 30,
        getDocP50Ms: 8,
        buildTimeMs: 1300,
        peakRssMb: 90,
      },
      {
        mrrAt5: 0.4,
        ndcgAt5: 0.5,
        avgRoundsToRightDoc: 2.5,
        facetPrecision: 0.65,
        searchP50Ms: 9,
        searchP95Ms: 20,
        getDocP50Ms: 11,
        buildTimeMs: 1200,
        peakRssMb: 95,
      },
    );

    expect(markdown).toContain("| Metric | Baseline | Current | Delta |");
    expect(markdown).toContain("MRR@5");
    expect(markdown).toContain("Facet Precision");
    expect(markdown).toContain("Search p95 (ms)");
    expect(markdown).toContain("Peak RSS (MB)");
  });

  it("shows regressions and improvements when case data is provided", () => {
    const baselineCases: RankedCase[] = [
      { expectedChunkId: "a", rankedChunkIds: ["a", "b"], roundsToRightDoc: 1 },
      { expectedChunkId: "b", rankedChunkIds: ["c", "d"], roundsToRightDoc: 3 },
    ];
    const currentCases: RankedCase[] = [
      { expectedChunkId: "a", rankedChunkIds: ["c", "d"], roundsToRightDoc: 3 },
      { expectedChunkId: "b", rankedChunkIds: ["b", "c"], roundsToRightDoc: 1 },
    ];

    const baselineSummary = summarizeCases(baselineCases);
    const currentSummary = summarizeCases(currentCases);

    const baselineDeltaCases = toDeltaCases(baselineCases);
    const currentDeltaCases = toDeltaCases(currentCases);

    const markdown = generateDeltaMarkdown(
      { summary: currentSummary, cases: currentDeltaCases },
      { summary: baselineSummary, cases: baselineDeltaCases },
    );

    // case-0 ("a"): baseline passed (found at rank 1), current failed -> regression
    expect(markdown).toContain("### Regressions");
    expect(markdown).toContain("case-0");

    // case-1 ("b"): baseline failed (not found), current passed (found at rank 1) -> improvement
    expect(markdown).toContain("### Improvements");
    expect(markdown).toContain("case-1");
  });
});
