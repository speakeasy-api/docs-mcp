import path from "node:path";
import Mustache from "mustache";
import type {
  CorpusMetadata,
  PromptDefinition,
  RrfWeights,
  SearchEngine,
  GetDocRequest,
  SearchRequest,
  FileEntry,
} from "@speakeasy-api/docs-mcp-core";
import { sentenceCase } from "change-case";
import { buildGetDocSchema, buildSearchDocsSchema } from "./schema.js";
import { properCase } from "./strings.js";
import {
  Server,
  type CacheHint,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ServerCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { createRequire } from "node:module";
import { CustomTool, ToolCallContext } from "./types.js";

const require = createRequire(import.meta.url);
const PKG_VERSION = readPackageVersion();
Mustache.escape = (value: string) => value;

/** Cache hints stamped on 2026-07-28 cacheable results, keyed by method. */
export type CacheHints = Partial<
  Record<
    | "tools/list"
    | "prompts/list"
    | "resources/list"
    | "resources/read"
    | "resources/templates/list",
    CacheHint
  >
>;

/**
 * Cache policy advertised on 2026-07-28 list results. The tool, prompt and
 * resource-template lists are fixed for the lifetime of the process and
 * identical for every caller, so shared caches may hold them briefly. The
 * resource list and resource contents keep the SDK's conservative default
 * (`ttlMs: 0`, `cacheScope: "private"`) because an `authenticate` hook may
 * gate them per caller.
 */
export const DEFAULT_CACHE_HINTS: CacheHints = {
  "tools/list": { ttlMs: 60_000, cacheScope: "public" },
  "prompts/list": { ttlMs: 60_000, cacheScope: "public" },
  "resources/templates/list": { ttlMs: 60_000, cacheScope: "public" },
};

export interface McpServerOptions {
  mcp?: {
    name?: string;
    version?: string;
    includeClientInfo?: boolean;
    /**
     * Cache hints stamped on 2026-07-28 cacheable results, keyed by method.
     * Defaults to {@link DEFAULT_CACHE_HINTS}; pass `{}` to fall back to the
     * SDK's conservative defaults for every method.
     */
    cacheHints?: CacheHints;
  };
  app: DocsServerOptions;
}

/**
 * Builds the low-level MCP `Server` for a docs corpus. Every request handler
 * is installed here because the tool, prompt and resource surfaces are
 * derived from the corpus metadata at runtime rather than registered
 * statically. The same instance serves both protocol eras: the 2025-era
 * `initialize` handshake and the 2026-07-28 per-request envelope.
 *
 * Capabilities follow the spec's rule that a server declares a capability
 * only when it supports it. Tools are always present. `prompts` is declared
 * only when the corpus defines prompts and `resources` only when some
 * taxonomy value is marked as an MCP resource; otherwise the corresponding
 * requests are not handled and answer "Method not found", and clients that
 * respect the declared capabilities never send them.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const app = new DocsServer(options.app);

  const instructions = app.getInstructions();
  const capabilities: ServerCapabilities = { tools: {} };
  if (app.hasPrompts()) {
    capabilities.prompts = {};
  }
  if (app.hasResources()) {
    capabilities.resources = {};
  }
  const server = new Server(
    {
      name: options.mcp?.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.mcp?.version ?? PKG_VERSION,
    },
    {
      capabilities,
      cacheHints: options.mcp?.cacheHints ?? DEFAULT_CACHE_HINTS,
      ...(instructions ? { instructions } : {}),
    },
  );

  server.setRequestHandler("tools/list", async () => {
    return app.getTools();
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const context: ToolCallContext = { signal: ctx.mcpReq.signal };
    const authInfo = ctx.http?.authInfo;
    if (authInfo) {
      context.authInfo = authInfo;
    }
    const headers = ctx.http?.req?.headers;
    if (headers) {
      context.headers = Object.fromEntries(headers);
    }
    if (options.mcp?.includeClientInfo) {
      const clientInfo = resolveClientInfo(server, ctx);
      if (clientInfo) {
        context.clientInfo = clientInfo;
      }
    }
    return app.callTool(request.params.name, request.params.arguments ?? {}, context);
  });

  if (capabilities.resources) {
    server.setRequestHandler("resources/list", async () => {
      const res = await app.getResources();
      return res satisfies ListResourcesResult;
    });

    server.setRequestHandler("resources/templates/list", async () => {
      return { resourceTemplates: [] } satisfies ListResourceTemplatesResult;
    });

    server.setRequestHandler("resources/read", async (request) => {
      const result = await app.readResource(request.params.uri);
      return result satisfies ReadResourceResult;
    });
  }

  if (capabilities.prompts) {
    server.setRequestHandler("prompts/list", async () => {
      return app.getPrompts() satisfies ListPromptsResult;
    });

    server.setRequestHandler("prompts/get", async (request) => {
      const result = await app.getPrompt(request.params.name, request.params.arguments);
      return result satisfies GetPromptResult;
    });
  }

  return server;
}

/**
 * The client identity comes from the `initialize` handshake on a 2025-era
 * connection and from the per-request `_meta` envelope on the 2026-07-28
 * revision, where no handshake exists. Both are best-effort: the envelope
 * `clientInfo` key is a SHOULD, and a stateless 2025-era request has no
 * handshake to remember.
 */
function resolveClientInfo(
  server: Server,
  ctx: ServerContext,
): { name: string; version: string } | undefined {
  const envelope = ctx.mcpReq.envelope as
    | { clientInfo?: { name?: unknown; version?: unknown } }
    | undefined;
  const fromEnvelope = envelope?.clientInfo;
  if (typeof fromEnvelope?.name === "string" && typeof fromEnvelope.version === "string") {
    return { name: fromEnvelope.name, version: fromEnvelope.version };
  }
  // 2025-era connections still negotiate the client identity through initialize.
  const negotiated = server.getClientVersion();
  if (negotiated) {
    return { name: negotiated.name, version: negotiated.version };
  }
  return undefined;
}

export interface DocsServerOptions {
  index: SearchEngine;
  metadata: CorpusMetadata;
  toolPrefix?: string;
  rrfWeights?: RrfWeights;
  vectorSearchAvailable?: boolean;
  customTools?: CustomTool[];
}

const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

class DocsServer {
  private readonly index: SearchEngine;
  private readonly metadata: CorpusMetadata;
  private readonly rrfWeights: RrfWeights | undefined;
  private readonly vectorSearchAvailable: boolean;
  private readonly searchToolName: string;
  private readonly getDocToolName: string;
  private readonly customTools: CustomTool[];

  constructor(options: DocsServerOptions) {
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

  /** Whether the corpus defines any prompt; drives the `prompts` capability. */
  hasPrompts(): boolean {
    return (this.metadata.prompts?.length ?? 0) > 0;
  }

  /** Whether any taxonomy value is marked as an MCP resource; drives the `resources` capability. */
  hasResources(): boolean {
    return this.getResourceFilters().length > 0;
  }

  getTools(): ListToolsResult {
    const searchQueryGuidance = this.vectorSearchAvailable
      ? "Use exact identifiers, method names, or conceptual queries."
      : "Use exact identifiers and method names.";
    const defaultSearchDescription = `Search the pre-indexed ${this.metadata.corpus_description} — the authoritative, complete reference for this documentation set. Contains API docs, code examples, and guides. ${searchQueryGuidance} Apply taxonomy filters to narrow results.`;

    const defaultGetDocDescription =
      "Retrieve the full content of a documentation page by its chunk_id (returned by search_docs). Each chunk is self-contained — do NOT set context on your first read. Only use context=1..3 if, after reading, you find the chunk references adjacent sections you need.";

    const builtIn = [
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

    const custom = this.customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    return { tools: [...builtIn, ...custom] };
  }

  getPrompts(): ListPromptsResult {
    const entries = this.metadata.prompts ?? [];
    const prompts = entries.map((prompt) => ({
      name: prompt.name,
      ...(prompt.title ? { title: prompt.title } : {}),
      ...(prompt.description ? { description: prompt.description } : {}),
      ...(prompt.arguments.length > 0
        ? {
            arguments: prompt.arguments.map((argument) => ({
              name: argument.name,
              ...(argument.description ? { description: argument.description } : {}),
              ...(argument.required !== undefined ? { required: argument.required } : {}),
            })),
          }
        : {}),
    }));

    return { prompts };
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    const prompt = this.findPrompt(name);
    const argumentsByName = args ?? {};

    for (const argument of prompt.arguments) {
      if (!argument.required) {
        continue;
      }

      const value = argumentsByName[argument.name];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Missing required prompt argument '${argument.name}'`);
      }
    }

    return {
      ...(prompt.description ? { description: prompt.description } : {}),
      messages: prompt.messages.map((message) => ({
        role: message.role,
        content: {
          type: "text",
          text: Mustache.render(message.content.text, argumentsByName),
        },
      })),
    };
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

  async getResources(): Promise<ListResourcesResult> {
    const entries = await this.listResourceEntries();
    const resources = entries.map((entry) => {
      return {
        uri: `docs:///${entry.filepath}`,
        name: entry.filepath,
        title: this.buildFileEntryTitle(entry),
        description: entry.filepath,
        mimeType: "text/markdown",
      };
    });
    return { resources };
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

    const entries = await this.listResourceEntries();

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

  buildFileEntryTitle(entry: FileEntry): string | undefined {
    const fileTitle = this.metadata.files?.[entry.filepath]?.title;
    const basename = path.basename(entry.filepath, path.extname(entry.filepath));
    const dir = path.dirname(entry.filepath);
    const dirParts = dir.split(path.sep).map((part) => properCase(sentenceCase(part)));
    const tail = fileTitle || properCase(sentenceCase(basename));

    return [...dirParts, tail].join(" / ");
  }

  private async listResourceEntries(): Promise<FileEntry[]> {
    const filters = this.getResourceFilters();
    if (filters.length === 0) {
      return [];
    }

    const entriesByPath = new Map<string, FileEntry>();
    for (const filter of filters) {
      const entries = await this.index.listFilepaths({ filters: filter });
      for (const entry of entries) {
        if (!entriesByPath.has(entry.filepath)) {
          entriesByPath.set(entry.filepath, entry);
        }
      }
    }

    return [...entriesByPath.values()].sort((a, b) => a.filepath.localeCompare(b.filepath));
  }

  private getResourceFilters(): Array<Record<string, string>> {
    const filters: Array<Record<string, string>> = [];

    for (const [field, config] of Object.entries(this.metadata.taxonomy)) {
      for (const [value, properties] of Object.entries(config.properties ?? {})) {
        if (properties.mcp_resource) {
          filters.push({ [field]: value });
        }
      }
    }

    return filters;
  }

  private findPrompt(name: string): PromptDefinition {
    const prompt = (this.metadata.prompts ?? []).find((entry) => entry.name === name);
    if (!prompt) {
      throw new Error(`Prompt '${name}' not found`);
    }
    return prompt;
  }
}

function parseSearchRequest(
  args: unknown,
  metadata: CorpusMetadata,
  rrfWeights?: RrfWeights,
): SearchRequest {
  const input = expectRecord(args, "search_docs input must be an object");
  const taxonomyKeys = Object.keys(metadata.taxonomy);
  assertAllowedKeys(input, ["query", "limit", "cursor", ...taxonomyKeys]);
  const query = expectString(input.query, "query");

  let limit = 10;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit)) {
      throw new Error("limit must be an integer");
    }
    if (input.limit < 1 || input.limit > 50) {
      throw new Error("limit must be between 1 and 50");
    }
    limit = input.limit;
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
  const input = expectRecord(args, "get_doc input must be an object");
  assertAllowedKeys(input, ["chunk_id", "context"]);
  const chunkId = expectString(input.chunk_id, "chunk_id");

  let context = 0;
  if (input.context !== undefined) {
    if (typeof input.context !== "number" || !Number.isInteger(input.context)) {
      throw new Error("context must be an integer");
    }
    if (input.context < 0 || input.context > 5) {
      throw new Error("context must be between 0 and 5");
    }
    context = input.context;
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

function expectRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
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

function readPackageVersion(): string {
  const pkg = require("../package.json");
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}
