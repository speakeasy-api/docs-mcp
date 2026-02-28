import matter from "gray-matter";
import picomatch from "picomatch";
import { ManifestTaxonomyConfigSchema } from "./manifest-schema.js";
import type {
  ChunkingStrategy,
  Manifest,
  ManifestOverride,
  ManifestTaxonomyFieldConfig,
  ResolvedFileConfig,
} from "./types.js";

const DEFAULT_STRATEGY: ChunkingStrategy = { chunk_by: "h2" };

/**
 * Union-merges taxonomy field configs from multiple manifests. If any manifest
 * sets `vector_collapse: true` for a key, the merged result includes it.
 * Similarly, if any manifest sets `mcp_resource: true` for a value, the merged
 * result includes it.
 */
export function mergeTaxonomyConfigs(
  manifests: Iterable<Manifest>,
): Record<string, ManifestTaxonomyFieldConfig> {
  const merged: Record<string, ManifestTaxonomyFieldConfig> = {};

  for (const manifest of manifests) {
    if (!manifest.taxonomy) continue;
    for (const [key, config] of Object.entries(manifest.taxonomy)) {
      if (config.vector_collapse) {
        if (!merged[key]) {
          merged[key] = { vector_collapse: false };
        }
        merged[key].vector_collapse = true;
      }
      if (config.properties) {
        for (const [value, props] of Object.entries(config.properties)) {
          if (props.mcp_resource) {
            if (!merged[key]) {
              merged[key] = { vector_collapse: false };
            }
            if (!merged[key].properties) {
              merged[key].properties = {};
            }
            merged[key].properties[value] = { mcp_resource: true };
          }
        }
      }
    }
  }

  return merged;
}

const HTML_HINT_REGEX = /<!--\s*mcp_chunking_hint:\s*(\{[^}]+\})\s*-->/;

export function parseManifest(input: unknown): Manifest {
  if (!input || typeof input !== "object") {
    throw new Error("manifest must be an object");
  }

  const manifest = input as Record<string, unknown>;
  const version = manifest.version;
  if (version !== "1") {
    throw new Error("manifest.version must be '1'");
  }

  const parsed: Manifest = { version };

  if (manifest.strategy) {
    parsed.strategy = parseStrategy(manifest.strategy);
  }
  if (manifest.metadata) {
    parsed.metadata = parseMetadata(manifest.metadata, "metadata");
  }
  if (manifest.taxonomy) {
    try {
      parsed.taxonomy = ManifestTaxonomyConfigSchema.parse(manifest.taxonomy);
    } catch (err) {
      throw new Error(
        `Invalid taxonomy config: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  if (manifest.instructions) {
    if (typeof manifest.instructions !== "string" || !manifest.instructions.trim()) {
      throw new Error("manifest.instructions must be a non-empty string");
    }
    parsed.instructions = manifest.instructions.trim();
  }
  if (manifest.overrides) {
    parsed.overrides = parseOverrides(manifest.overrides);
  }

  return parsed;
}

export function parseManifestJson(contents: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Manifest is not valid JSON");
  }
  return parseManifest(parsed);
}

export function resolveFileConfig(params: {
  relativeFilePath: string;
  manifestBaseDir?: string;
  manifest?: Manifest;
  markdown?: string;
  defaults?: Partial<ResolvedFileConfig>;
}): ResolvedFileConfig {
  const defaults: ResolvedFileConfig = {
    strategy: params.defaults?.strategy ?? DEFAULT_STRATEGY,
    metadata: params.defaults?.metadata ?? {},
  };

  const manifest = params.manifest;
  let metadata = {
    ...defaults.metadata,
    ...(manifest?.metadata ?? {}),
  };
  let strategy = manifest?.strategy ?? defaults.strategy;
  const overrideMatchPath = toManifestRelativePath(params.relativeFilePath, params.manifestBaseDir);

  if (manifest?.overrides) {
    for (const override of manifest.overrides) {
      const matcher = picomatch(override.pattern, { dot: true });
      if (!matcher(overrideMatchPath)) {
        continue;
      }

      if (override.metadata) {
        metadata = {
          ...metadata,
          ...override.metadata,
        };
      }

      if (override.strategy) {
        strategy = override.strategy;
      }
    }
  }

  if (params.markdown) {
    // HTML comment hints: applied after manifest but before frontmatter
    const htmlHint = parseHtmlChunkingHint(params.markdown);
    if (htmlHint) {
      strategy = { ...strategy, chunk_by: htmlHint.chunk_by };
    }

    // Frontmatter overrides: highest precedence
    const frontmatterOverrides = parseFrontmatterOverrides(params.markdown);

    if (frontmatterOverrides.metadata) {
      metadata = {
        ...metadata,
        ...frontmatterOverrides.metadata,
      };
    }

    if (frontmatterOverrides.strategy) {
      strategy = frontmatterOverrides.strategy;
    }
  }

  return {
    strategy,
    metadata,
  };
}

function toManifestRelativePath(relativeFilePath: string, manifestBaseDir?: string): string {
  const normalizedFile = toPosixPath(relativeFilePath);
  if (!manifestBaseDir) {
    return normalizedFile;
  }

  const normalizedBase = toPosixPath(manifestBaseDir).replace(/^\/+|\/+$/g, "");
  if (!normalizedBase || normalizedBase === ".") {
    return normalizedFile;
  }

  const basePrefix = `${normalizedBase}/`;
  if (normalizedFile.startsWith(basePrefix)) {
    return normalizedFile.slice(basePrefix.length);
  }

  return normalizedFile;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseFrontmatterOverrides(markdown: string): {
  strategy?: ChunkingStrategy;
  metadata?: Record<string, string>;
} {
  const parsed = matter(markdown);
  if (!parsed.data || typeof parsed.data !== "object") {
    return {};
  }

  const data = parsed.data as Record<string, unknown>;

  let strategy: ChunkingStrategy | undefined;
  if (data.mcp_strategy) {
    strategy = parseStrategy(data.mcp_strategy);
  } else if (data.mcp_chunking_hint) {
    strategy = {
      chunk_by: parseChunkBy(data.mcp_chunking_hint),
    };
  }

  let metadata: Record<string, string> | undefined;
  if (data.metadata) {
    metadata = parseMetadata(data.metadata, "metadata");
  }
  if (data.mcp_metadata) {
    metadata = {
      ...(metadata ?? {}),
      ...parseMetadata(data.mcp_metadata, "mcp_metadata"),
    };
  }

  const result: {
    strategy?: ChunkingStrategy;
    metadata?: Record<string, string>;
  } = {};
  if (strategy) {
    result.strategy = strategy;
  }
  if (metadata) {
    result.metadata = metadata;
  }
  return result;
}

/**
 * Scans markdown for an HTML comment chunking hint of the form:
 *   <!-- mcp_chunking_hint: {"chunk_by": "h3"} -->
 *
 * Returns a partial strategy override (just `chunk_by`) if found and valid,
 * or undefined if no hint is present or parsing fails.
 */
export function parseHtmlChunkingHint(
  markdown: string,
): Pick<ChunkingStrategy, "chunk_by"> | undefined {
  const match = HTML_HINT_REGEX.exec(markdown);
  if (!match) {
    return undefined;
  }

  const jsonStr = match[1];
  if (!jsonStr) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (parsed.chunk_by !== undefined) {
      const chunkBy = parseChunkBy(parsed.chunk_by);
      return { chunk_by: chunkBy };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseOverrides(value: unknown): ManifestOverride[] {
  if (!Array.isArray(value)) {
    throw new Error("manifest.overrides must be an array");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`manifest.overrides[${index}] must be an object`);
    }

    const override = entry as Record<string, unknown>;
    if (typeof override.pattern !== "string" || !override.pattern.trim()) {
      throw new Error(`manifest.overrides[${index}].pattern must be a non-empty string`);
    }

    const parsed: ManifestOverride = {
      pattern: override.pattern.trim(),
    };

    if (override.strategy) {
      parsed.strategy = parseStrategy(override.strategy);
    }
    if (override.metadata) {
      parsed.metadata = parseMetadata(override.metadata, `manifest.overrides[${index}].metadata`);
    }

    return parsed;
  });
}

function parseStrategy(value: unknown): ChunkingStrategy {
  if (!value || typeof value !== "object") {
    throw new Error("strategy must be an object");
  }

  const strategy = value as Record<string, unknown>;

  const chunkBy = parseChunkBy(strategy.chunk_by);
  const maxChunkSize = strategy.max_chunk_size;
  const minChunkSize = strategy.min_chunk_size;

  const parsed: ChunkingStrategy = {
    chunk_by: chunkBy,
  };

  if (maxChunkSize !== undefined) {
    parsed.max_chunk_size = asPositiveInteger(maxChunkSize, "max_chunk_size");
  }
  if (minChunkSize !== undefined) {
    parsed.min_chunk_size = asPositiveInteger(minChunkSize, "min_chunk_size");
  }

  return parsed;
}

function parseChunkBy(value: unknown): ChunkingStrategy["chunk_by"] {
  if (value !== "h1" && value !== "h2" && value !== "h3" && value !== "file") {
    throw new Error("chunk_by must be one of: h1, h2, h3, file");
  }

  return value;
}

function parseMetadata(value: unknown, fieldName: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const metadata = value as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`${fieldName} contains an empty key`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`${fieldName}.${key} must be a string`);
    }

    const val = rawValue.trim();
    if (!val) {
      throw new Error(`${fieldName}.${key} cannot be empty`);
    }

    normalized[key] = val;
  }

  return normalized;
}

function asPositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value as number;
}
