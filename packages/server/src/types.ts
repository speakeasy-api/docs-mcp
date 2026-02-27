export type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface ToolCallContext {
  /** Validated auth info from transport middleware (HTTP only). */
  authInfo?: AuthInfo;
  /** HTTP request headers (HTTP transport only). */
  headers?: Record<string, string | string[] | undefined>;
  /** Client name/version from MCP init handshake. Available after the init handshake completes. */
  clientInfo?: { name: string; version: string };
  /** Abort signal for request cancellation. */
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface CallToolResult {
  content: TextContent[];
  isError: boolean;
}

export interface ToolProvider {
  getTools(): ToolDefinition[];
  callTool(name: string, args: unknown, context: ToolCallContext): Promise<CallToolResult>;
  getResources(): Promise<ResourceDefinition[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
}

export interface CustomTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, context: ToolCallContext) => Promise<CallToolResult>;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface ReadResourceResult {
  contents: ResourceContent[];
}
