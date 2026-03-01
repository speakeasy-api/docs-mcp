import type {
  CorpusMetadata,
  RrfWeights,
  SearchEngine,
  GetDocRequest,
  SearchRequest,
} from "@speakeasy-api/docs-mcp-core";
import { buildGetDocSchema, buildSearchDocsSchema } from "./schema.js";
import type {
  CallToolResult,
  CustomTool,
  ReadResourceResult,
  ResourceDefinition,
  ToolCallContext,
  ToolDefinition,
  ToolProvider,
} from "./types.js";

export interface McpDocsServerOptions {
  index: SearchEngine;
  metadata: CorpusMetadata;
  toolPrefix?: string;
  rrfWeights?: RrfWeights;
  vectorSearchAvailable?: boolean;
  customTools?: CustomTool[];
}

const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class McpDocsServer implements ToolProvider {
  private readonly index: SearchEngine;
  private readonly metadata: CorpusMetadata;
  private readonly rrfWeights: RrfWeights | undefined;
  private readonly vectorSearchAvailable: boolean;
  private readonly searchToolName: string;
  private readonly getDocToolName: string;
  private readonly customTools: CustomTool[];

  constructor(options: McpDocsServerOptions) {
    this.index = options.index;
    this.metadata = options.metadata;
    this.rrfWeights = options.rrfWeights;
    this.vectorSearchAvailable = options.vectorSearchAvailable ?? false;
    const prefix = options.toolPrefix;
    this.searchToolName = prefix ? `${prefix}_search_docs` : "search_docs";
    this.getDocToolName = prefix ? `${prefix}_get_doc` : "get_doc";
    this.customTools = options.customTools ?? [];

    // Validate built-in tool names fit within 64-char MCP limit
    for (const name of [this.searchToolName, this.getDocToolName]) {
      if (!MCP_TOOL_NAME_PATTERN.test(name)) {
        throw new Error(
          `Built-in tool name '${name}' exceeds 64 characters or contains invalid characters. Use a shorter toolPrefix.`,
        );
      }
    }

    // Validate custom tool names
    const builtInNames = new Set([this.searchToolName, this.getDocToolName]);
    const seenCustomNames = new Set<string>();
    for (const tool of this.customTools) {
      if (!MCP_TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(
          `Custom tool name '${tool.name}' must match MCP spec: alphanumeric/dash/underscore, 1-64 chars.`,
        );
      }
      if (builtInNames.has(tool.name)) {
        throw new Error(`Custom tool name '${tool.name}' collides with a built-in tool name.`);
      }
      if (seenCustomNames.has(tool.name)) {
        throw new Error(`Duplicate custom tool name '${tool.name}'.`);
      }
      seenCustomNames.add(tool.name);
    }
  }

  getInstructions(): string | undefined {
    return this.metadata.mcpServerInstructions;
  }

  getTools(): ToolDefinition[] {
    const defaultSearchDescription = `Search the pre-indexed ${this.metadata.corpus_description} — the authoritative, complete reference for this documentation set. Contains API docs, code examples, and guides. Use exact identifiers, method names, or conceptual queries. Apply taxonomy filters to narrow results.`;

    const defaultGetDocDescription =
      "Retrieve the full content of a documentation page by its chunk_id (returned by search_docs). Each chunk is self-contained — do NOT set context on your first read. Only use context=1..3 if, after reading, you find the chunk references adjacent sections you need.";

    const builtIn: ToolDefinition[] = [
      {
        name: this.searchToolName,
        description: this.metadata.tool_descriptions?.search_docs ?? defaultSearchDescription,
        inputSchema: buildSearchDocsSchema(this.metadata),
      },
      {
        name: this.getDocToolName,
        description: this.metadata.tool_descriptions?.get_doc ?? defaultGetDocDescription,
        inputSchema: buildGetDocSchema(),
      },
    ];

    const custom: ToolDefinition[] = this.customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    return [...builtIn, ...custom];
  }

  async callTool(name: string, args: unknown, context: ToolCallContext): Promise<CallToolResult> {
    if (name === this.searchToolName) {
      return this.handleSearchDocs(args);
    }

    if (name === this.getDocToolName) {
      return this.handleGetDoc(args);
    }

    const customTool = this.customTools.find((t) => t.name === name);
    if (customTool) {
      try {
        return await customTool.handler(args, context);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }

    return errorResult(`Unknown tool '${name}'.`);
  }

  private async handleSearchDocs(args: unknown): Promise<CallToolResult> {
    try {
      const request = parseSearchRequest(args, this.metadata, this.rrfWeights);
      const result = await this.index.search(request);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
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
        isError: false,
      };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "get_doc failed");
    }
  }

  async getResources(): Promise<ResourceDefinition[]> {
    const resources: ResourceDefinition[] = [];

    for (const [dimKey, field] of Object.entries(this.metadata.taxonomy)) {
      if (!field.properties) continue;

      for (const [value, props] of Object.entries(field.properties)) {
        if (!props.mcp_resource) continue;

        const entries = await this.index.listFilepaths({
          filters: { [dimKey]: value },
        });

        for (const entry of entries) {
          resources.push({
            uri: `docs:///${entry.filepath}`,
            name: entry.filepath,
            description: `${entry.filepath} (${dimKey}=${value})`,
            mimeType: "text/markdown",
          });
        }
      }
    }

    return resources;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const parsed = new URL(uri);
    if (parsed.protocol !== "docs:") {
      throw new Error(`Invalid URI scheme: ${parsed.protocol}. Expected 'docs:'`);
    }

    let filepath = parsed.pathname;
    // remove leading slash
    if (filepath.startsWith("/")) {
      filepath = filepath.slice(1);
    }
    if (!filepath) {
      throw new Error(`Invalid URI: missing filepath in '${uri}'`);
    }

    console.log("Looking up resource for filepath:", filepath);
    const entries = await this.index.listFilepaths({
      filters: {},
    });

    const entry = entries.find((e) => e.filepath === filepath);
    if (!entry) {
      throw new Error(`Resource not found: ${uri}`);
    }

    // Change this to grab the full document, not chunks.
    const result = await this.index.getDoc({
      chunk_id: entry.firstChunkId,
      context: -1,
    });

    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: result.text,
        },
      ],
    };
  }
}

function parseSearchRequest(
  args: unknown,
  metadata: CorpusMetadata,
  rrfWeights?: RrfWeights,
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
        `Invalid taxonomy value for '${key}': '${normalized}'. Allowed values: ${allowed.join(", ")}`,
      );
    }

    filters[key] = normalized;
  }

  const request: SearchRequest = {
    query,
    limit,
    filters,
    taxonomy_keys: taxonomyKeys,
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
    context,
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
    isError: true,
  };
}
