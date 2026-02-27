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
  callTool(name: string, args: unknown): Promise<CallToolResult>;
}

export interface CustomTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<CallToolResult>;
}
