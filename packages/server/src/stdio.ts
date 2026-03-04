import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallContext, ToolProvider } from "./types.js";

const require = createRequire(import.meta.url);
const PKG_VERSION = readPackageVersion();

export interface StartStdioServerOptions {
  name?: string;
  version?: string;
}

export async function startStdioServer(
  app: ToolProvider,
  options: StartStdioServerOptions = {},
): Promise<void> {
  const instructions = app.getInstructions();
  const server = new McpServer(
    {
      name: options.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.version ?? PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      ...(instructions ? { instructions } : {}),
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = app.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    return { tools } satisfies ListToolsResult;
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const context: ToolCallContext = { signal: extra.signal };
    const clientVersion = server.server.getClientVersion();
    if (clientVersion) {
      context.clientInfo = { name: clientVersion.name, version: clientVersion.version };
    }
    const result = await app.callTool(request.params.name, request.params.arguments ?? {}, context);
    return result;
  });

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await app.getResources();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        title: r.title,
        description: r.description,
        mimeType: r.mimeType,
      })),
    } satisfies ListResourcesResult;
  });

  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] } satisfies ListResourceTemplatesResult;
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const result = await app.readResource(request.params.uri);
    return result;
  });

  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: app.getPrompts(),
    } satisfies ListPromptsResult;
  });

  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const result = await app.getPrompt(request.params.name, request.params.arguments);
    return result as GetPromptResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function readPackageVersion(): string {
  const pkg = require("../package.json");
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}
