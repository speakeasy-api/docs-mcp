import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function startStdioServer(factory: () => McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  const server = factory();
  await server.connect(transport);
}
