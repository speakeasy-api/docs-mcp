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
