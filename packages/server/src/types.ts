import type {
  AuthInfo,
  CallToolResult,
  ListToolsResult,
  Server,
} from "@modelcontextprotocol/server";
export type { AuthInfo };

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

export interface CreateDocsServerRuntimeOptions {
  logger?: Logger;
  pretty?: boolean;
  logLevel?: string;
}

export interface DocsServer {
  (): Server;
  buildInfo: BuildInfo;
}

export interface ToolCallContext {
  /** Validated auth info from transport middleware (HTTP only). */
  authInfo?: AuthInfo;
  /** HTTP request headers (HTTP transport only). */
  headers?: Record<string, string | string[] | undefined>;
  /**
   * Client name/version, from the `initialize` handshake on 2025-era
   * connections or the per-request `_meta` envelope on the 2026-07-28
   * revision. Best-effort and may be absent in stateless/degraded handling.
   */
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
