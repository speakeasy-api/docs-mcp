import type { Server } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer, McpServerOptions } from "../server.js";

export async function createTestServer(
  options: McpServerOptions,
): Promise<AsyncDisposable & { server: Server; client: Client }> {
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
