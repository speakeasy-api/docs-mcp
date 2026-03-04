export type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
export type {
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  GetPromptResult,
  ListPromptsResult,
  ReadResourceResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ListToolsResult["tools"][number]["inputSchema"];
}

export interface ToolProvider {
  getInstructions(): string | undefined;
  getTools(): ToolDefinition[];
  getPrompts(): ListPromptsResult["prompts"];
  getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
  callTool(name: string, args: unknown, context: ToolCallContext): Promise<CallToolResult>;
  getResources(): Promise<ResourceDefinition[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
}

export interface CustomTool {
  name: string;
  description: string;
  inputSchema: ListToolsResult["tools"][number]["inputSchema"];
  handler: (args: unknown, context: ToolCallContext) => Promise<CallToolResult>;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  mimeType?: string | undefined;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
}
