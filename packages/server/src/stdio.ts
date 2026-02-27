import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
