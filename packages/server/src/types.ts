export type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface BuildInfo {
  name: string;
  version: string;
  gitCommit?: string | undefined;
  buildDate?: string | undefined;
}

export interface Logger {
  debug: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
}

export interface LoggingOptions {
  logger?: Logger;
  pretty?: boolean;
  logLevel?: string;
}

export interface DocsServer {
  (): McpServer;
  buildInfo: BuildInfo;
}

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
