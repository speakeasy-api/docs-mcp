import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, McpServerOptions } from "../src/server";

export async function createTestServer(
  options: McpServerOptions,
): Promise<AsyncDisposable & { server: McpServer; client: Client }> {
  const server = createMcpServer(options);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    server,
    client,
    [Symbol.asyncDispose]: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}
