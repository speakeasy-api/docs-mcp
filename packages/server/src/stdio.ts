import type { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export interface StdioServerHandle {
  shutdown: () => Promise<void>;
}

/**
 * Serves the factory over stdio. The opening exchange on the connection
 * selects the protocol era: a 2025-era `initialize` pins a legacy instance,
 * a 2026-07-28 enveloped request pins a modern one. One instance from the
 * factory serves the whole connection either way.
 */
export async function startStdioServer(factory: () => Server): Promise<StdioServerHandle> {
  const handle = serveStdio(() => factory(), { legacy: "serve" });

  const shutdown = async () => {
    await handle.close().catch((err) => {
      if (err) console.error("Failed to close stdio server:", err);
    });
  };

  return { shutdown };
}
