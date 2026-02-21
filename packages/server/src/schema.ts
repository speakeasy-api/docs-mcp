import type { CorpusMetadata } from "@speakeasy-api/docs-mcp-core";

export function buildSearchDocsSchema(metadata: CorpusMetadata): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    query: {
      type: "string",
      description: "The search query (e.g., 'how to paginate', 'RateLimitError')."
    },
    limit: {
      type: "integer",
      description: "Maximum number of results to return. Default is 10.",
      minimum: 1,
      maximum: 50,
      default: 10
    },
    cursor: {
      type: "string",
      description:
        "Opaque pagination token returned from a previous search. Omit for the first page."
    }
  };

  for (const [key, field] of Object.entries(metadata.taxonomy)) {
    properties[key] = {
      type: "string",
      description: field.description ?? `Filter results by ${key}.`,
      enum: field.values
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["query"]
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
          "The exact ID of the chunk to retrieve, as returned by search_docs (e.g., 'guides/retries.md#backoff-strategy')."
      },
      context: {
        type: "integer",
        description:
          "Number of adjacent chunks to include before and after the target chunk. Default is 0.",
        minimum: 0,
        maximum: 5,
        default: 0
      }
    },
    required: ["chunk_id"]
  };
}
