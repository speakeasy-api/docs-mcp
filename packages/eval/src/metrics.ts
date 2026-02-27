export interface RankedCase {
  expectedChunkId: string;
  rankedChunkIds: string[];
  roundsToRightDoc: number;
  name?: string;
  category?: string;
}

export interface EvalSummary {
  mrrAt5: number;
  ndcgAt5: number;
  avgRoundsToRightDoc: number;
  /** Fraction of cases where the expected chunk was found in the top 5 results */
  facetPrecision: number;
  searchP50Ms: number;
  searchP95Ms: number;
  getDocP50Ms: number;
  buildTimeMs: number;
  peakRssMb: number;
}

export function computeMrrAtK(cases: RankedCase[], k: number): number {
  if (cases.length === 0) {
    return 0;
  }

  const total = cases.reduce((sum, testCase) => {
    const position = testCase.rankedChunkIds.slice(0, k).indexOf(testCase.expectedChunkId);
    if (position < 0) {
      return sum;
    }
    return sum + 1 / (position + 1);
  }, 0);

  return total / cases.length;
}

export function computeNdcgAtK(cases: RankedCase[], k: number): number {
  if (cases.length === 0) {
    return 0;
  }

  const total = cases.reduce((sum, testCase) => {
    const position = testCase.rankedChunkIds.slice(0, k).indexOf(testCase.expectedChunkId);
    if (position < 0) {
      return sum;
    }

    const dcg = 1 / log2(position + 2);
    const idealDcg = 1;
    return sum + dcg / idealDcg;
  }, 0);

  return total / cases.length;
}

export function computeAvgRoundsToRightDoc(cases: RankedCase[]): number {
  if (cases.length === 0) {
    return 0;
  }

  const total = cases.reduce((sum, testCase) => sum + testCase.roundsToRightDoc, 0);
  return total / cases.length;
}

export function summarizeCases(
  cases: RankedCase[],
  timings: {
    searchLatenciesMs?: number[];
    getDocLatenciesMs?: number[];
    buildTimeMs?: number;
    peakRssMb?: number;
  } = {},
): EvalSummary {
  return {
    mrrAt5: round(computeMrrAtK(cases, 5)),
    ndcgAt5: round(computeNdcgAtK(cases, 5)),
    avgRoundsToRightDoc: round(computeAvgRoundsToRightDoc(cases)),
    facetPrecision: round(
      cases.filter((c) => c.rankedChunkIds.slice(0, 5).includes(c.expectedChunkId)).length /
        (cases.length || 1),
    ),
    searchP50Ms: round(percentile(timings.searchLatenciesMs ?? [], 0.5)),
    searchP95Ms: round(percentile(timings.searchLatenciesMs ?? [], 0.95)),
    getDocP50Ms: round(percentile(timings.getDocLatenciesMs ?? [], 0.5)),
    buildTimeMs: round(timings.buildTimeMs ?? 0),
    peakRssMb: round(timings.peakRssMb ?? 0),
  };
}

export interface CategoryBreakdown {
  category: string;
  caseCount: number;
  facetPrecision: number;
  mrrAt5: number;
  ndcgAt5: number;
}

export function computeCategoryBreakdown(cases: RankedCase[]): CategoryBreakdown[] {
  const groups = new Map<string, RankedCase[]>();
  for (const c of cases) {
    const cat = c.category ?? "uncategorized";
    let group = groups.get(cat);
    if (!group) {
      group = [];
      groups.set(cat, group);
    }
    group.push(c);
  }

  const result: CategoryBreakdown[] = [];
  for (const [category, group] of groups) {
    result.push({
      category,
      caseCount: group.length,
      facetPrecision: round(
        group.filter((c) => c.rankedChunkIds.slice(0, 5).includes(c.expectedChunkId)).length /
          (group.length || 1),
      ),
      mrrAt5: round(computeMrrAtK(group, 5)),
      ndcgAt5: round(computeNdcgAtK(group, 5)),
    });
  }

  return result.sort((a, b) => a.category.localeCompare(b.category));
}

function log2(value: number): number {
  return Math.log(value) / Math.log(2);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}
