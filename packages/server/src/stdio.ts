import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export interface StdioServerHandle {
  server: McpServer;
  transport: StdioServerTransport;
  shutdown: () => Promise<void>;
}

export async function startStdioServer(factory: () => McpServer): Promise<StdioServerHandle> {
  const transport = new StdioServerTransport();
  const server = factory();
  await server.connect(transport);

  const shutdown = async () => {
    await transport.close().catch((err) => {
      if (err) console.error("Failed to close transport:", err);
    });
    await server.close().catch((err) => {
      if (err) console.error("Failed to close mcp server:", err);
    });
  };

  return { server, transport, shutdown };
}
