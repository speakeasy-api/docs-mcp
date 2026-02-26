import type {
  CorpusMetadata,
  RrfWeights,
  SearchEngine,
  GetDocRequest,
  SearchRequest
} from "@speakeasy-api/docs-mcp-core";
import { buildGetDocSchema, buildSearchDocsSchema } from "./schema.js";
import type { CallToolResult, ToolDefinition } from "./types.js";

export interface McpDocsServerOptions {
  index: SearchEngine;
  metadata: CorpusMetadata;
  toolPrefix?: string;
  rrfWeights?: RrfWeights;
  vectorSearchAvailable?: boolean;
}

export class McpDocsServer {
  private readonly index: SearchEngine;
  private readonly metadata: CorpusMetadata;
  private readonly rrfWeights: RrfWeights | undefined;
  private readonly vectorSearchAvailable: boolean;
  private readonly searchToolName: string;
  private readonly getDocToolName: string;

  constructor(options: McpDocsServerOptions) {
    this.index = options.index;
    this.metadata = options.metadata;
    this.rrfWeights = options.rrfWeights;
    this.vectorSearchAvailable = options.vectorSearchAvailable ?? false;
    const prefix = options.toolPrefix;
    this.searchToolName = prefix ? `${prefix}_search_docs` : "search_docs";
    this.getDocToolName = prefix ? `${prefix}_get_doc` : "get_doc";
  }

  getTools(): ToolDefinition[] {
    const searchDescription = `Search the pre-indexed ${this.metadata.corpus_description} — the authoritative, complete reference for this library/SDK. Contains API docs, code examples, and guides. Use exact identifiers, method names, or conceptual queries. Apply taxonomy filters to narrow results.`;

    return [
      {
        name: this.searchToolName,
        description: searchDescription,
        inputSchema: buildSearchDocsSchema(this.metadata)
      },
      {
        name: this.getDocToolName,
        description:
          "Retrieve the full content of a documentation page by its chunk_id (returned by search_docs). Use this to read complete API signatures, code examples, and usage details. Optionally include surrounding sections with context=1..5.",
        inputSchema: buildGetDocSchema()
      }
    ];
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    if (name === this.searchToolName) {
      return this.handleSearchDocs(args);
    }

    if (name === this.getDocToolName) {
      return this.handleGetDoc(args);
    }

    return errorResult(`Unknown tool '${name}'.`);
  }

  private async handleSearchDocs(args: unknown): Promise<CallToolResult> {
    try {
      const request = parseSearchRequest(args, this.metadata, this.rrfWeights);
      const result = await this.index.search(request);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false
      };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "search_docs failed");
    }
  }

  private async handleGetDoc(args: unknown): Promise<CallToolResult> {
    try {
      const request = parseGetDocRequest(args);
      const result = await this.index.getDoc(request);
      return {
        content: [{ type: "text", text: result.text }],
        isError: false
      };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "get_doc failed");
    }
  }
}

function parseSearchRequest(
  args: unknown,
  metadata: CorpusMetadata,
  rrfWeights?: RrfWeights
): SearchRequest {
  if (!args || typeof args !== "object") {
    throw new Error("search_docs input must be an object");
  }

  const input = args as Record<string, unknown>;
  const taxonomyKeys = Object.keys(metadata.taxonomy);
  assertAllowedKeys(input, ["query", "limit", "cursor", ...taxonomyKeys]);
  const query = expectString(input.query, "query");

  let limit = 10;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit)) {
      throw new Error("limit must be an integer");
    }
    const parsedLimit = input.limit as number;
    if (parsedLimit < 1 || parsedLimit > 50) {
      throw new Error("limit must be between 1 and 50");
    }
    limit = parsedLimit;
  }

  const cursor = input.cursor === undefined ? undefined : expectString(input.cursor, "cursor");

  const filters: Record<string, string> = {};
  for (const key of taxonomyKeys) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }

    const normalized = expectString(value, key);
    const allowed = metadata.taxonomy[key]?.values ?? [];
    if (!allowed.includes(normalized)) {
      throw new Error(
        `Invalid taxonomy value for '${key}': '${normalized}'. Allowed values: ${allowed.join(", ")}`
      );
    }

    filters[key] = normalized;
  }

  const request: SearchRequest = {
    query,
    limit,
    filters,
    taxonomy_keys: taxonomyKeys
  };

  if (cursor !== undefined) {
    request.cursor = cursor;
  }

  if (rrfWeights) {
    request.rrf_weights = rrfWeights;
  }

  return request;
}

function parseGetDocRequest(args: unknown): GetDocRequest {
  if (!args || typeof args !== "object") {
    throw new Error("get_doc input must be an object");
  }

  const input = args as Record<string, unknown>;
  assertAllowedKeys(input, ["chunk_id", "context"]);
  const chunkId = expectString(input.chunk_id, "chunk_id");

  let context = 0;
  if (input.context !== undefined) {
    if (!Number.isInteger(input.context)) {
      throw new Error("context must be an integer");
    }
    const parsedContext = input.context as number;
    if (parsedContext < 0 || parsedContext > 5) {
      throw new Error("context must be between 0 and 5");
    }
    context = parsedContext;
  }

  return {
    chunk_id: chunkId,
    context
  };
}

function expectString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function assertAllowedKeys(input: Record<string, unknown>, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`Unexpected field '${key}'`);
    }
  }
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
