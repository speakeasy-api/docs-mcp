import semver from "semver";
import type { CorpusMetadata, EmbeddingMetadata, TaxonomyField } from "./types.js";

/**
 * Returns taxonomy keys that have `vector_collapse: true`, i.e. dimensions
 * whose values should be collapsed at search time.
 */
export function getCollapseKeys(taxonomy: Record<string, TaxonomyField>): string[] {
  return Object.entries(taxonomy)
    .filter(([, field]) => field.vector_collapse === true)
    .map(([key]) => key);
}

const LIMITS = {
  maxKeys: 64,
  maxKeyLength: 64,
  maxValuesPerKey: 512,
  maxValueLength: 128
} as const;

export interface NormalizeMetadataOptions {
  supportedMajor?: number;
}

export function normalizeMetadata(
  input: unknown,
  options: NormalizeMetadataOptions = {}
): CorpusMetadata {
  if (!input || typeof input !== "object") {
    throw new Error("metadata must be an object");
  }

  const metadata = input as Record<string, unknown>;
  const supportedMajor = options.supportedMajor ?? 1;

  const metadataVersion = asNonEmptyString(metadata.metadata_version, "metadata_version");
  if (!semver.valid(metadataVersion)) {
    throw new Error("metadata_version must be valid semver");
  }

  const parsed = semver.parse(metadataVersion);
  if (!parsed || parsed.major !== supportedMajor) {
    throw new Error(
      `Unsupported metadata_version major: expected ${supportedMajor}.x.x, got ${metadataVersion}`
    );
  }

  const corpusDescription = asNonEmptyString(metadata.corpus_description, "corpus_description");

  const taxonomy = normalizeTaxonomy(metadata.taxonomy);
  const stats = normalizeStats(metadata.stats);
  const embedding = normalizeEmbedding(metadata.embedding);

  return {
    metadata_version: metadataVersion,
    corpus_description: corpusDescription,
    taxonomy,
    stats,
    embedding
  };
}

function normalizeTaxonomy(value: unknown): Record<string, TaxonomyField> {
  if (!value || typeof value !== "object") {
    throw new Error("taxonomy must be an object");
  }

  const raw = value as Record<string, unknown>;
  const entries = Object.entries(raw);

  if (entries.length > LIMITS.maxKeys) {
    throw new Error(`taxonomy has too many keys (max ${LIMITS.maxKeys})`);
  }

  const normalized: Record<string, TaxonomyField> = {};

  for (const [rawKey, rawField] of entries) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error("taxonomy keys cannot be empty");
    }
    if (key.length > LIMITS.maxKeyLength) {
      throw new Error(`taxonomy key '${key}' exceeds max length ${LIMITS.maxKeyLength}`);
    }

    if (!rawField || typeof rawField !== "object") {
      throw new Error(`taxonomy field '${key}' must be an object`);
    }

    const field = rawField as Record<string, unknown>;
    const values = normalizeValues(field.values, key);
    const description = field.description === undefined ? undefined : asTrimmedString(field.description);

    const vectorCollapse = field.vector_collapse === true ? true : undefined;

    normalized[key] = {
      ...(description ? { description } : {}),
      values,
      ...(vectorCollapse ? { vector_collapse: true } : {})
    };
  }

  return normalized;
}

function normalizeValues(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`taxonomy['${key}'].values must be an array`);
  }

  if (value.length > LIMITS.maxValuesPerKey) {
    throw new Error(
      `taxonomy['${key}'].values exceeds max length ${LIMITS.maxValuesPerKey}`
    );
  }

  const deduped = new Set<string>();
  for (const raw of value) {
    const normalized = asTrimmedString(raw);
    if (!normalized) {
      throw new Error(`taxonomy['${key}'].values cannot include empty strings`);
    }
    if (normalized.length > LIMITS.maxValueLength) {
      throw new Error(
        `taxonomy['${key}'].value '${normalized}' exceeds max length ${LIMITS.maxValueLength}`
      );
    }
    deduped.add(normalized);
  }

  return [...deduped].sort((a, b) => a.localeCompare(b));
}

function normalizeStats(value: unknown): CorpusMetadata["stats"] {
  if (!value || typeof value !== "object") {
    throw new Error("stats must be an object");
  }

  const stats = value as Record<string, unknown>;
  const totalChunks = asPositiveInteger(stats.total_chunks, "stats.total_chunks", true);
  const totalFiles = asPositiveInteger(stats.total_files, "stats.total_files", true);
  const indexedAt = asNonEmptyString(stats.indexed_at, "stats.indexed_at");

  const sourceCommitRaw = stats.source_commit;
  let sourceCommit: string | null | undefined;
  if (sourceCommitRaw === undefined) {
    sourceCommit = undefined;
  } else if (sourceCommitRaw === null) {
    sourceCommit = null;
  } else {
    sourceCommit = asTrimmedString(sourceCommitRaw);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
      throw new Error("stats.source_commit must be a 40-char lowercase SHA-1");
    }
  }

  const result: CorpusMetadata["stats"] = {
    total_chunks: totalChunks,
    total_files: totalFiles,
    indexed_at: indexedAt
  };

  if (sourceCommit !== undefined) {
    result.source_commit = sourceCommit;
  }

  return result;
}

function normalizeEmbedding(value: unknown): EmbeddingMetadata | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    throw new Error("embedding must be null or an object");
  }

  const embedding = value as Record<string, unknown>;
  const provider = asNonEmptyString(embedding.provider, "embedding.provider");
  const model = asNonEmptyString(embedding.model, "embedding.model");
  const dimensions = asPositiveInteger(embedding.dimensions, "embedding.dimensions", false);

  return { provider, model, dimensions };
}

function asTrimmedString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }
  return value.trim();
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function asPositiveInteger(value: unknown, fieldName: string, allowZero: boolean): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }

  const min = allowZero ? 0 : 1;
  if ((value as number) < min) {
    throw new Error(`${fieldName} must be >= ${min}`);
  }

  return value as number;
}
