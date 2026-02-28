import type { CorpusMetadata } from "@speakeasy-api/docs-mcp-core";

export function buildSearchDocsSchema(metadata: CorpusMetadata): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    query: {
      type: "string",
      description:
        "The search query — use method names, class names, error types, or describe what you want to do (e.g., 'links.create', 'RateLimitError', 'how to paginate').",
    },
    limit: {
      type: "integer",
      description: "Maximum number of results to return. Default is 10.",
      minimum: 1,
      maximum: 50,
      default: 10,
    },
    cursor: {
      type: "string",
      description:
        "Opaque pagination token returned from a previous search. Omit for the first page.",
    },
  };

  for (const [key, field] of Object.entries(metadata.taxonomy)) {
    properties[key] = {
      type: "string",
      description: field.description ?? `Filter results by ${key}.`,
      enum: field.values,
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["query"],
  };
}

export function buildGetDocSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      chunk_id: {
        type: "string",
        description:
          "The exact ID of the chunk to retrieve, as returned by search_docs (e.g., 'guides/retries.md#backoff-strategy'). Mutually exclusive with 'symbols'.",
      },
      context: {
        type: "integer",
        description:
          "Number of adjacent chunks to include before and after the target chunk. Default 0 (recommended). Chunks are self-contained; only increase after an initial read if you need broader page context. Only used with chunk_id.",
        minimum: 0,
        maximum: 5,
        default: 0,
      },
      symbols: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
        description:
          "Array of symbol names to retrieve (e.g., 'Tenant.CreateTenant', 'operations.CreateTenantRequest', 'entrypoint:ciscoplatform.SDK'). Mutually exclusive with 'chunk_id'. Max 5.",
      },
      hydrate: {
        type: "boolean",
        description:
          "When true, resolves and includes all transitive type dependencies for the requested symbols. Default is false.",
        default: false,
      },
    },
  };
}
