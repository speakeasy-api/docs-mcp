import { z } from "zod";

export const ChunkingStrategySchema = z
  .object({
    chunk_by: z
      .enum(["h1", "h2", "h3", "file"])
      .describe(
        "The heading level at which to split markdown into chunks. 'h1' splits at top-level headings, 'h2'/'h3' at progressively finer granularity, and 'file' treats the entire file as one chunk.",
      )
      .meta({ examples: ["h2"] }),
    max_chunk_size: z
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum chunk size in characters (default: 20000). Oversized chunks are first split recursively at finer heading levels (e.g. h2→h3→h4→…→h6), preserving semantic structure and breadcrumbs. Only when no further sub-headings exist does it fall back to AST node boundary splitting.",
      )
      .meta({ examples: [8000] }),
    min_chunk_size: z
      .int()
      .positive()
      .optional()
      .describe(
        "Minimum chunk size in characters. Trailing chunks smaller than this are merged into the preceding chunk to avoid fragments.",
      )
      .meta({ examples: [200] }),
  })
  .describe("Controls how markdown files are split into chunks for indexing.");

export const ManifestOverrideSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe(
        "A glob pattern matched against file paths relative to the directory containing the manifest.",
      )
      .meta({ examples: ["guides/advanced/*.md"] }),
    strategy: ChunkingStrategySchema.optional().describe(
      "Chunking strategy override for files matching this pattern. Replaces the root strategy entirely.",
    ),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Metadata key-value pairs merged with root metadata for matching files (override keys win). Each key becomes a filterable taxonomy dimension in the search API.",
      )
      .meta({ examples: [{ scope: "global-guide" }] }),
  })
  .describe(
    "Overrides the default chunking strategy and/or metadata for files matching a glob pattern. Within the overrides array, later matches take precedence.",
  );

export const TaxonomyValuePropertiesSchema = z
  .object({
    mcp_resource: z
      .boolean()
      .default(false)
      .describe(
        "When true, documents with this taxonomy dimension value are exposed as first-class MCP resources.",
      ),
  })
  .describe("Per-value configuration for a taxonomy dimension value.");

export const TaxonomyFieldConfigSchema = z
  .object({
    vector_collapse: z
      .boolean()
      .default(false)
      .describe(
        "When true, this taxonomy dimension identifies content variants that are near-identical in vector space (e.g. the same API operation documented in multiple SDK languages). At search time, results sharing the same content identity — determined by normalizing this field's value out of the filepath — are collapsed to the highest-scoring result. Has no effect when a filter for this field is active, since the filter already restricts to a single value.",
      ),
    properties: z
      .record(z.string(), TaxonomyValuePropertiesSchema)
      .optional()
      .describe(
        "Per-value configuration for this taxonomy dimension. Keys are taxonomy values (e.g. 'typescript', 'python').",
      ),
  })
  .describe("Configuration for a taxonomy field's search-time behavior.");

export const ManifestTaxonomyConfigSchema = z
  .record(z.string(), TaxonomyFieldConfigSchema)
  .describe(
    "Per-field configuration for taxonomy dimensions. Controls search-time behavior such as cross-language result collapsing.",
  );

export const ManifestSchema = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe(
        "JSON Schema URI for editor validation. Typically set automatically by SchemaStore; can be added explicitly.",
      ),
    version: z
      .literal("1")
      .describe("Schema version. Must be '1'.")
      .meta({ examples: ["1"] }),
    strategy: ChunkingStrategySchema.optional().describe(
      "Default chunking strategy applied to all files in this directory tree unless overridden by a more specific rule.",
    ),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Key-value pairs attached to every chunk produced from this directory tree. Each key becomes a filterable taxonomy dimension exposed as an enum parameter on the search tool.",
      )
      .meta({ examples: [{ language: "typescript", scope: "sdk-specific" }] }),
    taxonomy: ManifestTaxonomyConfigSchema.optional().meta({
      examples: [{ language: { vector_collapse: true } }],
    }),
    instructions: z
      .string()
      .optional()
      .describe(
        "Custom MCP server instructions sent to clients during initialization. Helps coding agents understand what this server provides and how to use it effectively.",
      ),
    overrides: z
      .array(ManifestOverrideSchema)
      .optional()
      .describe(
        "Per-file-pattern overrides for chunking strategy and metadata. Evaluated top-to-bottom; last match wins.",
      ),
  })
  .describe(
    "Docs MCP configuration file (.docs-mcp.json) that controls how documentation is chunked, tagged, and indexed for search.",
  );
