import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLanceDbIndex, LanceDbSearchEngine } from "../lancedb.js";
import { ManifestTaxonomyConfigSchema } from "../manifest-schema.js";
import { getScoreMultipliers, normalizeMetadata } from "../metadata.js";
import { scoreMultiplier } from "../search-common.js";
import { InMemorySearchEngine } from "../search.js";
import type { Chunk } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function chunk(id: string, content: string, metadata: Record<string, string>): Chunk {
  const filepath = id.split("#")[0]!;
  return {
    chunk_id: id,
    filepath,
    heading: "Pagination",
    heading_level: 2,
    content,
    content_text: content,
    breadcrumb: `${filepath} > Pagination`,
    chunk_index: 0,
    metadata,
  };
}

// The legacy chunk sorts first by chunk ID, so it wins ties without a multiplier.
const chunks: Chunk[] = [
  chunk("guides/a-legacy.md#pagination", "Paginate list results with a cursor", {
    status: "legacy",
  }),
  chunk("guides/b-current.md#pagination", "Paginate list results with a cursor", {
    status: "current",
  }),
];

describe("score multipliers", () => {
  it("accepts positive multipliers in the manifest taxonomy", () => {
    const parsed = ManifestTaxonomyConfigSchema.parse({
      status: { properties: { legacy: { score_multiplier: 0.5 } } },
    });
    expect(parsed.status?.properties?.legacy).toEqual({
      mcp_resource: false,
      score_multiplier: 0.5,
    });

    for (const invalid of [0, -1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        ManifestTaxonomyConfigSchema.parse({
          status: { properties: { legacy: { score_multiplier: invalid } } },
        }),
      ).toThrow();
    }
  });

  it("preserves multipliers through metadata normalization", () => {
    const metadata = normalizeMetadata({
      metadata_version: "1.1.0",
      corpus_description: "Test corpus",
      taxonomy: {
        status: {
          values: ["current", "legacy"],
          properties: {
            current: { score_multiplier: 1 },
            legacy: { score_multiplier: 0.5 },
          },
        },
        scope: {
          values: ["guide"],
          properties: { guide: { mcp_resource: true } },
        },
      },
      stats: { total_chunks: 2, total_files: 2, indexed_at: "2025-01-01T00:00:00Z" },
      embedding: null,
    });

    expect(metadata.taxonomy.status?.properties).toEqual({
      current: { mcp_resource: false, score_multiplier: 1 },
      legacy: { mcp_resource: false, score_multiplier: 0.5 },
    });
    expect(metadata.taxonomy.scope?.properties).toEqual({ guide: { mcp_resource: true } });
    expect(getScoreMultipliers(metadata.taxonomy)).toEqual({ status: { legacy: 0.5 } });
  });

  it("rejects non-positive multipliers in metadata", () => {
    expect(() =>
      normalizeMetadata({
        metadata_version: "1.1.0",
        corpus_description: "Test corpus",
        taxonomy: {
          status: { values: ["legacy"], properties: { legacy: { score_multiplier: 0 } } },
        },
        stats: { total_chunks: 1, total_files: 1, indexed_at: "2025-01-01T00:00:00Z" },
        embedding: null,
      }),
    ).toThrow("taxonomy['status'].properties['legacy'].score_multiplier");
  });

  it("multiplies the factors of every matching taxonomy value", () => {
    const multipliers = { status: { legacy: 0.5 }, scope: { guide: 1.5 } };
    const metadata: Record<string, string> = { status: "legacy", scope: "guide" };

    expect(scoreMultiplier((key) => metadata[key] ?? "", multipliers)).toBe(0.75);
    expect(scoreMultiplier(() => "", multipliers)).toBe(1);
  });

  it("reorders in-memory search results", async () => {
    const query = { query: "paginate cursor", limit: 10, filters: {} };

    const unweighted = await new InMemorySearchEngine(chunks).search(query);
    expect(unweighted.hits[0]?.chunk_id).toBe("guides/a-legacy.md#pagination");

    const weighted = await new InMemorySearchEngine(chunks, {
      scoreMultipliers: { status: { legacy: 0.5 } },
    }).search(query);
    expect(weighted.hits.map((hit) => hit.chunk_id)).toEqual([
      "guides/b-current.md#pagination",
      "guides/a-legacy.md#pagination",
    ]);
    expect(weighted.hits[1]?.score).toBeCloseTo(unweighted.hits[0]!.score * 0.5);
  });

  it("reorders LanceDB search results", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-score-multiplier-"));
    tempDirs.push(dir);
    await buildLanceDbIndex({ dbPath: dir, chunks, metadataKeys: ["status"] });
    const query = { query: "paginate cursor", limit: 10, filters: {} };

    const unweighted = await (
      await LanceDbSearchEngine.open({ dbPath: dir, metadataKeys: ["status"] })
    ).search(query);
    expect(unweighted.hits[0]?.chunk_id).toBe("guides/a-legacy.md#pagination");

    const weighted = await (
      await LanceDbSearchEngine.open({
        dbPath: dir,
        metadataKeys: ["status"],
        scoreMultipliers: { status: { legacy: 0.5 } },
      })
    ).search(query);
    expect(weighted.hits.map((hit) => hit.chunk_id)).toEqual([
      "guides/b-current.md#pagination",
      "guides/a-legacy.md#pagination",
    ]);
    expect(weighted.hits[1]?.score).toBeCloseTo(unweighted.hits[0]!.score * 0.5, 5);
  });
});
