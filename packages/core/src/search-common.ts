const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(MAX_LIMIT, limit));
}

export function isChunkIdFormat(value: string): boolean {
  return /^(?!\s)([^#\s]+)(#[^#\s]+)?$/.test(value);
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function tokenizeSearchText(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function makeSnippet(content: string, query: string): string {
  const normalized = normalizeSearchText(content);
  const terms = tokenizeSearchText(normalizeSearchText(query));
  if (normalized.length <= 220) {
    return normalized;
  }

  let anchor = 0;
  for (const term of terms) {
    const index = normalized.indexOf(term);
    if (index >= 0) {
      anchor = index;
      break;
    }
  }

  const start = Math.max(0, anchor - 60);
  const end = Math.min(normalized.length, start + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";

  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

/**
 * Computes a dedup key for collapsing content-equivalent results across
 * taxonomy variant axes (e.g. the same operation documented in multiple SDK
 * languages). Returns null when no collapsing applies.
 */
export function dedupKey(
  filepath: string,
  heading: string,
  chunkId: string,
  getMetadataValue: (key: string) => string,
  collapseKeys: string[]
): string | null {
  if (collapseKeys.length === 0) return null;

  const parts = filepath.split("/");
  let anyNormalized = false;

  for (const key of collapseKeys) {
    const value = getMetadataValue(key);
    if (!value) return null;

    const idx = parts.indexOf(value);
    if (idx >= 0) {
      parts[idx] = "*";
      anyNormalized = true;
    }
  }

  if (!anyNormalized) return null;

  const partMatch = chunkId.match(/-part-(\d+)$/);
  const partSuffix = partMatch ? `:${partMatch[1]}` : "";

  return `${parts.join("/")}:${heading}${partSuffix}`;
}

export function matchesMetadataFilters(
  metadata: Record<string, string>,
  filters: Record<string, string>,
  taxonomyKeys?: string[]
): boolean {
  const language = filters.language;
  const scope = filters.scope;

  // Only apply the scope/language auto-include expansion when both keys exist
  // in the taxonomy (or when taxonomyKeys is not provided, for backwards compatibility).
  const hasScope = !taxonomyKeys || taxonomyKeys.includes("scope");
  const hasLanguage = !taxonomyKeys || taxonomyKeys.includes("language");

  if (hasScope && hasLanguage && language && !scope) {
    const chunkScope = metadata.scope;
    const chunkLanguage = metadata.language;

    if (chunkScope === "sdk-specific") {
      if (chunkLanguage !== language) {
        return false;
      }
    } else if (chunkScope === "global-guide") {
      // Auto-include global guides.
    } else if (chunkLanguage && chunkLanguage !== language) {
      return false;
    }
  } else {
    if (language && metadata.language !== language) {
      return false;
    }
    if (scope && metadata.scope !== scope) {
      return false;
    }
  }

  for (const [key, value] of Object.entries(filters)) {
    if (key === "language" || key === "scope") {
      continue;
    }

    if (metadata[key] !== value) {
      return false;
    }
  }

  return true;
}
