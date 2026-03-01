/**
 * Shared MCP server pre-flight: spawn the server over stdio, perform the
 * initialize handshake and tools/list request, then return the full server
 * identity, instructions, and tool definitions (including descriptions).
 *
 * Used by the runner to verify server health and surface what the model
 * will actually see — regardless of which agent provider is in use.
 */

import { spawn } from "node:child_process";

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpPreflightResult {
  /** Server name from the initialize response. */
  serverName: string | undefined;
  /** Server version from the initialize response. */
  serverVersion: string | undefined;
  /** Server instructions returned in the initialize response (if any). */
  instructions: string | undefined;
  /** Tools returned by tools/list — includes name and description. */
  tools: McpToolInfo[];
}

/**
 * Spawn an MCP server over stdio and perform a quick handshake to discover
 * tools, instructions, and server identity.
 */
export function preflightMcpServer(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<McpPreflightResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `MCP server timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`,
        ),
      );
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`MCP server failed to spawn: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(
          new Error(
            `MCP server exited (code ${code}) with no output. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        resolve(parseMcpOutput(stdout));
      } catch (err) {
        reject(
          new Error(
            `MCP server responded but parse failed: ${err instanceof Error ? err.message : err}. stdout: ${stdout.slice(0, 500)}`,
          ),
        );
      }
    });

    // Send MCP initialize + tools/list over stdin (JSON-RPC over stdio)
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "eval-preflight", version: "1.0" },
      },
    });
    const initialized = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const toolsList = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    child.stdin!.write(initialize + "\n");
    child.stdin!.write(initialized + "\n");
    child.stdin!.write(toolsList + "\n");
    // Close stdin so the server knows no more requests are coming
    setTimeout(() => {
      child.stdin!.end();
    }, 2000);
  });
}

/**
 * Parse the JSON-RPC responses from stdout, extracting server identity,
 * instructions (from initialize, id=1), and full tool info (from
 * tools/list, id=2).
 */
function parseMcpOutput(stdout: string): McpPreflightResult {
  const lines = stdout.trim().split("\n");

  let tools: McpToolInfo[] | undefined;
  let instructions: string | undefined;
  let serverName: string | undefined;
  let serverVersion: string | undefined;

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;

      // initialize response (id=1) — server identity + instructions
      if (msg.id === 1 && msg.result) {
        const result = msg.result as Record<string, unknown>;
        if (typeof result.instructions === "string" && result.instructions) {
          instructions = result.instructions;
        }
        const serverInfo = result.serverInfo as Record<string, unknown> | undefined;
        if (serverInfo) {
          if (typeof serverInfo.name === "string") serverName = serverInfo.name;
          if (typeof serverInfo.version === "string") serverVersion = serverInfo.version;
        }
      }

      // tools/list response (id=2)
      if (msg.id === 2 && msg.result) {
        const result = msg.result as Record<string, unknown>;
        const toolArr = result.tools as Array<Record<string, unknown>> | undefined;
        if (toolArr) {
          tools = toolArr.map((t) => ({
            name: typeof t.name === "string" ? t.name : "unknown",
            description: typeof t.description === "string" ? t.description : "",
          }));
        }
      }
    } catch {
      // skip non-JSON lines
    }
  }

  if (!tools) {
    throw new Error("No tools/list response found in output");
  }

  return { serverName, serverVersion, instructions, tools };
}
