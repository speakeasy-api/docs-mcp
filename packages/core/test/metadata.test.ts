import { describe, expect, it } from "vitest";
import { normalizeMetadata } from "../src/metadata.js";

/**
 * Helper to build a minimal valid metadata object.
 * Tests can override specific fields.
 */
function validMetadata(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    metadata_version: "1.0.0",
    corpus_description: "Test corpus",
    taxonomy: {
      language: {
        values: ["en", "fr"],
        description: "The language of the document",
      },
    },
    stats: {
      total_chunks: 100,
      total_files: 10,
      indexed_at: "2025-01-01T00:00:00Z",
      source_commit: null,
    },
    embedding: null,
    ...overrides,
  };
}

describe("normalizeMetadata", () => {
  // ─── Valid input ────────────────────────────────────────────────

  it("accepts valid metadata and returns CorpusMetadata", () => {
    const input = validMetadata();
    const result = normalizeMetadata(input);

    expect(result.metadata_version).toBe("1.0.0");
    expect(result.corpus_description).toBe("Test corpus");
    expect(result.taxonomy.language).toBeDefined();
    expect(result.taxonomy.language!.values).toEqual(["en", "fr"]);
    expect(result.stats.total_chunks).toBe(100);
    expect(result.stats.total_files).toBe(10);
    expect(result.embedding).toBeNull();
  });

  it("accepts valid metadata with embedding config", () => {
    const input = validMetadata({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });

    const result = normalizeMetadata(input);

    expect(result.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
  });

  it("accepts valid metadata with source_commit", () => {
    const commit = "a".repeat(40);
    const input = validMetadata({
      stats: {
        total_chunks: 50,
        total_files: 5,
        indexed_at: "2025-06-01T12:00:00Z",
        source_commit: commit,
      },
    });

    const result = normalizeMetadata(input);
    expect(result.stats.source_commit).toBe(commit);
  });

  // ─── metadata_version validation ───────────────────────────────

  it("rejects invalid semver version", () => {
    const input = validMetadata({ metadata_version: "not-semver" });
    expect(() => normalizeMetadata(input)).toThrow(/metadata_version must be valid semver/);
  });

  it("rejects missing metadata_version", () => {
    const input = validMetadata();
    delete input.metadata_version;
    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects non-string metadata_version", () => {
    const input = validMetadata({ metadata_version: 123 });
    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects empty metadata_version", () => {
    const input = validMetadata({ metadata_version: "   " });
    expect(() => normalizeMetadata(input)).toThrow(/metadata_version must be a non-empty string/);
  });

  it("rejects unsupported metadata_version major", () => {
    const input = validMetadata({ metadata_version: "2.0.0" });
    expect(() => normalizeMetadata(input)).toThrow(
      /Unsupported metadata_version major: expected 1\.x\.x, got 2\.0\.0/,
    );
  });

  it("supports custom supportedMajor option", () => {
    const input = validMetadata({ metadata_version: "2.0.0" });
    const result = normalizeMetadata(input, { supportedMajor: 2 });
    expect(result.metadata_version).toBe("2.0.0");
  });

  it("rejects major mismatch with custom supportedMajor", () => {
    const input = validMetadata({ metadata_version: "1.0.0" });
    expect(() => normalizeMetadata(input, { supportedMajor: 2 })).toThrow(
      /Unsupported metadata_version major: expected 2\.x\.x, got 1\.0\.0/,
    );
  });

  // ─── corpus_description validation ─────────────────────────────

  it("rejects empty corpus_description", () => {
    const input = validMetadata({ corpus_description: "   " });
    expect(() => normalizeMetadata(input)).toThrow(
      /corpus_description must be a non-empty string/,
    );
  });

  it("rejects missing corpus_description", () => {
    const input = validMetadata();
    delete input.corpus_description;
    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects non-string corpus_description", () => {
    const input = validMetadata({ corpus_description: 42 });
    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  // ─── taxonomy validation ───────────────────────────────────────

  it("rejects too many taxonomy keys", () => {
    const taxonomy: Record<string, { values: string[] }> = {};
    for (let i = 0; i < 65; i++) {
      taxonomy[`key_${i}`] = { values: ["val"] };
    }
    const input = validMetadata({ taxonomy });

    expect(() => normalizeMetadata(input)).toThrow(/taxonomy has too many keys \(max 64\)/);
  });

  it("rejects empty taxonomy values", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["en", ""] },
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /taxonomy\['language'\]\.values cannot include empty strings/,
    );
  });

  it("rejects taxonomy values that are only whitespace", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["  "] },
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /taxonomy\['language'\]\.values cannot include empty strings/,
    );
  });

  it("rejects taxonomy with empty key", () => {
    const input = validMetadata({
      taxonomy: {
        "": { values: ["val"] },
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/taxonomy keys cannot be empty/);
  });

  it("rejects non-string taxonomy values", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: [123] },
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects taxonomy field without values array", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: "not-an-array" },
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /taxonomy\['language'\]\.values must be an array/,
    );
  });

  it("rejects taxonomy with non-object field", () => {
    const input = validMetadata({
      taxonomy: {
        language: "not-an-object",
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/taxonomy field 'language' must be an object/);
  });

  it("rejects non-object taxonomy", () => {
    const input = validMetadata({ taxonomy: "not-an-object" });
    expect(() => normalizeMetadata(input)).toThrow(/taxonomy must be an object/);
  });

  // ─── Taxonomy normalization ────────────────────────────────────

  it("trims taxonomy values", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["  en  ", "  fr  "] },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.values).toEqual(["en", "fr"]);
  });

  it("deduplicates taxonomy values", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["en", "fr", "en", "fr"] },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.values).toEqual(["en", "fr"]);
  });

  it("sorts taxonomy values alphabetically", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["fr", "en", "de"] },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.values).toEqual(["de", "en", "fr"]);
  });

  it("trims, deduplicates, and sorts together", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: [" fr ", "en", " en ", "de"] },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.values).toEqual(["de", "en", "fr"]);
  });

  it("preserves taxonomy description when present", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["en"], description: "The language" },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.description).toBe("The language");
  });

  it("omits taxonomy description when absent", () => {
    const input = validMetadata({
      taxonomy: {
        language: { values: ["en"] },
      },
    });

    const result = normalizeMetadata(input);
    expect(result.taxonomy.language!.description).toBeUndefined();
  });

  // ─── source_commit validation ──────────────────────────────────

  it("accepts null source_commit", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: null,
      },
    });

    const result = normalizeMetadata(input);
    expect(result.stats.source_commit).toBeNull();
  });

  it("rejects source_commit that is not 40 hex chars", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: "tooshort",
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /stats\.source_commit must be a 40-char lowercase SHA-1/,
    );
  });

  it("rejects source_commit with uppercase hex", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: "A".repeat(40),
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /stats\.source_commit must be a 40-char lowercase SHA-1/,
    );
  });

  it("rejects non-string source_commit", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: 12345,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("accepts valid 40-char lowercase hex source_commit", () => {
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: commit,
      },
    });

    const result = normalizeMetadata(input);
    expect(result.stats.source_commit).toBe(commit);
  });

  it("omits source_commit from result when undefined in input", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
      },
    });

    const result = normalizeMetadata(input);
    expect("source_commit" in result.stats).toBe(false);
  });

  // ─── Top-level validation ──────────────────────────────────────

  it("rejects null input", () => {
    expect(() => normalizeMetadata(null)).toThrow(/metadata must be an object/);
  });

  it("rejects undefined input", () => {
    expect(() => normalizeMetadata(undefined)).toThrow(/metadata must be an object/);
  });

  it("rejects array input", () => {
    // Arrays pass the typeof === "object" check, so fail when accessing metadata_version
    expect(() => normalizeMetadata([])).toThrow(/expected string/);
  });

  it("rejects primitive string input", () => {
    expect(() => normalizeMetadata("string")).toThrow(/metadata must be an object/);
  });

  it("rejects primitive number input", () => {
    expect(() => normalizeMetadata(42)).toThrow(/metadata must be an object/);
  });

  it("rejects boolean input", () => {
    expect(() => normalizeMetadata(true)).toThrow(/metadata must be an object/);
  });

  // ─── stats validation ──────────────────────────────────────────

  it("rejects non-integer total_chunks", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 1.5,
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: null,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/stats\.total_chunks must be an integer/);
  });

  it("rejects non-integer total_files", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 10,
        total_files: 2.5,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: null,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/stats\.total_files must be an integer/);
  });

  it("rejects non-numeric total_chunks", () => {
    const input = validMetadata({
      stats: {
        total_chunks: "ten",
        total_files: 1,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: null,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/stats\.total_chunks must be an integer/);
  });

  it("rejects non-object stats", () => {
    const input = validMetadata({ stats: "not-an-object" });
    expect(() => normalizeMetadata(input)).toThrow(/stats must be an object/);
  });

  it("accepts zero total_chunks", () => {
    const input = validMetadata({
      stats: {
        total_chunks: 0,
        total_files: 0,
        indexed_at: "2025-01-01T00:00:00Z",
        source_commit: null,
      },
    });

    const result = normalizeMetadata(input);
    expect(result.stats.total_chunks).toBe(0);
    expect(result.stats.total_files).toBe(0);
  });

  // ─── embedding validation ──────────────────────────────────────

  it("rejects embedding with zero dimensions", () => {
    const input = validMetadata({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 0,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/embedding\.dimensions must be >= 1/);
  });

  it("rejects embedding with negative dimensions", () => {
    const input = validMetadata({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: -1,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/embedding\.dimensions must be >= 1/);
  });

  it("rejects embedding with non-integer dimensions", () => {
    const input = validMetadata({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1.5,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/embedding\.dimensions must be an integer/);
  });

  it("rejects embedding missing provider", () => {
    const input = validMetadata({
      embedding: {
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects embedding with empty provider", () => {
    const input = validMetadata({
      embedding: {
        provider: "   ",
        model: "text-embedding-3-small",
        dimensions: 1536,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(
      /embedding\.provider must be a non-empty string/,
    );
  });

  it("rejects embedding missing model", () => {
    const input = validMetadata({
      embedding: {
        provider: "openai",
        dimensions: 1536,
      },
    });

    expect(() => normalizeMetadata(input)).toThrow(/expected string/);
  });

  it("rejects non-object embedding", () => {
    const input = validMetadata({ embedding: "not-an-object" });
    expect(() => normalizeMetadata(input)).toThrow(/embedding must be null or an object/);
  });

  it("accepts undefined embedding (treated as null)", () => {
    const input = validMetadata();
    delete input.embedding;
    const result = normalizeMetadata(input);
    expect(result.embedding).toBeNull();
  });
});
