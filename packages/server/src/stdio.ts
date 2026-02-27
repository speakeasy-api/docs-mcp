import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallContext, ToolProvider } from "./types.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as {
  version: string;
};

export interface StartStdioServerOptions {
  name?: string;
  version?: string;
}

export async function startStdioServer(
  app: ToolProvider,
  options: StartStdioServerOptions = {},
): Promise<void> {
  const server = new Server(
    {
      name: options.name ?? "@speakeasy-api/docs-mcp-server",
      version: options.version ?? PKG_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = app.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
    }));

    return { tools } satisfies ListToolsResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const context: ToolCallContext = { signal: extra.signal };
    const clientVersion = server.getClientVersion();
    if (clientVersion) {
      context.clientInfo = { name: clientVersion.name, version: clientVersion.version };
    }
    const result = await app.callTool(request.params.name, request.params.arguments ?? {}, context);
    return result as CallToolResult;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await app.getResources();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    } satisfies ListResourcesResult;
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] } satisfies ListResourceTemplatesResult;
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const result = await app.readResource(request.params.uri);
    return result as ReadResourceResult;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
