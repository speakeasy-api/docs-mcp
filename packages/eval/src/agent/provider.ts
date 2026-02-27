export type AgentProviderName = "claude" | "openai";

// --- Normalized event types ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  durationApiMs: number;
  numTurns: number;
}

export type AgentProviderEvent =
  | {
      type: "init";
      model: string;
      tools: string[];
      mcpServers: Array<{ name: string; status: string }>;
    }
  | {
      type: "text";
      text: string;
      usage?: TokenUsage;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      result: string;
    }
  | {
      type: "done";
      subtype: "success" | "error";
      answer: string;
      errors: string[];
      usage: RunUsage;
    };

// --- Provider config ---

export interface AgentProviderMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentProviderConfig {
  /** Model name. Undefined = let the provider pick its own default. */
  model?: string;
  systemPrompt?: string;
  prompt: string;
  workspaceDir: string;
  maxTurns: number;
  maxBudgetUsd: number;
  mcpServers?: Record<string, AgentProviderMcpServer>;
  allowedTools?: string[];
  env: Record<string, string>;
  debug?: boolean;
}

// --- Provider interface ---

export interface AgentProvider {
  readonly name: AgentProviderName;
  run(config: AgentProviderConfig): AsyncGenerator<AgentProviderEvent>;
}

// --- Factory ---

const DEFAULT_MODELS: Record<AgentProviderName, string | undefined> = {
  claude: "claude-sonnet-4-20250514",
  openai: undefined, // let codex CLI pick its own default
};

/**
 * Returns the default model for a provider, or undefined if the provider
 * should pick its own default (e.g. Codex CLI selects from its models cache).
 */
export function defaultModelForProvider(name: AgentProviderName): string | undefined {
  return DEFAULT_MODELS[name];
}

export async function resolveAgentProvider(
  explicit?: string,
): Promise<AgentProvider> {
  if (explicit === "claude") {
    const { ClaudeAgentProvider } = await import("./provider-claude.js");
    return new ClaudeAgentProvider();
  }

  if (explicit === "openai") {
    const { CodexAgentProvider } = await import("./provider-codex.js");
    return new CodexAgentProvider();
  }

  // Auto-detect from environment
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasClaude =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_CODE_USE_BEDROCK ||
    !!process.env.CLAUDE_CODE_USE_VERTEX;

  if (hasOpenAI && hasClaude) {
    process.stderr.write(
      "Warning: both ANTHROPIC_API_KEY and OPENAI_API_KEY are set; defaulting to Claude. Use --provider to override.\n",
    );
    const { ClaudeAgentProvider } = await import("./provider-claude.js");
    return new ClaudeAgentProvider();
  }

  if (hasOpenAI && !hasClaude) {
    const { CodexAgentProvider } = await import("./provider-codex.js");
    return new CodexAgentProvider();
  }

  // Default: Claude (its CLI handles its own auth)
  const { ClaudeAgentProvider } = await import("./provider-claude.js");
  return new ClaudeAgentProvider();
}
