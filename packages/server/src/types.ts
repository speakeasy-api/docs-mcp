export type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface ToolCallContext {
  /** Validated auth info from transport middleware (HTTP only). */
  authInfo?: AuthInfo;
  /** HTTP request headers (HTTP transport only). */
  headers?: Record<string, string | string[] | undefined>;
  /** Client name/version from MCP init handshake. Best-effort and may be absent in stateless/degraded handling. */
  clientInfo?: { name: string; version: string };
  /** Abort signal for request cancellation. */
  signal: AbortSignal;
}

export interface CustomTool {
  name: string;
  description: string;
  inputSchema: ListToolsResult["tools"][number]["inputSchema"];
  handler: (args: unknown, context: ToolCallContext) => Promise<CallToolResult>;
}
