export interface DocsRepoSpec {
  /** Git clone URL */
  url: string;
  /** Branch, tag, or commit (default: "main") */
  ref?: string;
  /** Subdirectory within the repo that contains docs (default: "." — repo root) */
  docsPath?: string;
  /** Inline .docs-mcp.json manifest if the repo lacks one */
  docsConfig?: Record<string, unknown>;
}

export interface AgentScenario {
  id: string;
  name: string;
  prompt: string;
  assertions: AgentAssertion[];
  category?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  /** Shell command run in workspace before agent starts */
  setup?: string;
  /** Corpus description for the docs index. Flows into MCP tool descriptions. */
  description?: string;
  /** Custom tool descriptions for the MCP server tools. */
  toolDescriptions?: { search_docs?: string; get_doc?: string };
  /** Git repo to clone and index docs from. Takes precedence over docsDir. */
  docsSpec?: DocsRepoSpec;
  /** Path to docs directory. Resolved relative to scenario file. CLI auto-builds + caches the index. */
  docsDir?: string;
  /** Resolved index directory path. Set at runtime by the CLI after building the index. */
  indexDir?: string;
}

export type AgentAssertion =
  | { type: "contains"; value: string; soft?: boolean }
  | { type: "not_contains"; value: string; soft?: boolean }
  | { type: "matches"; pattern: string; flags?: string; soft?: boolean }
  | { type: "file_contains"; path: string; value: string; soft?: boolean }
  | { type: "file_matches"; path: string; pattern: string; flags?: string; soft?: boolean }
  | { type: "script"; command: string; name: string; when_env?: string; soft?: boolean };

export interface AssertionResult {
  assertion: AgentAssertion;
  passed: boolean;
  message: string;
}

export interface WorkspaceFile {
  /** Relative path within workspace */
  path: string;
  /** File content (may be truncated) */
  content: string;
  /** Inferred language from file extension */
  lang?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  timestampMs: number;
}

export interface AgentScenarioResult {
  id: string;
  name: string;
  category?: string;
  /** Did the agent call any docs-mcp tool? */
  activated: boolean;
  /** Did ALL assertions pass? */
  passed: boolean;
  assertionResults: AssertionResult[];
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  toolsCalled: Record<string, number>;
  toolCallTrace: ToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  mcpToolCalls: number;
  mcpToolResultChars: number;
  workspaceFiles: WorkspaceFile[];
  finalAnswer: string;
  resultSubtype: string;
  errors?: string[];
}

export interface AgentCategoryBreakdown {
  category: string;
  scenarioCount: number;
  activationRate: number;
  passRate: number;
  avgTurns: number;
  avgCostUsd: number;
}

export interface AgentEvalSummary {
  totalScenarios: number;
  activationRate: number;
  passRate: number;
  avgTurns: number;
  medianTurns: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgDurationMs: number;
  medianDurationMs: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadInputTokens: number;
  avgCacheCreationInputTokens: number;
  avgMcpToolCalls: number;
  mcpToolUsageDistribution: Record<string, number>;
  toolUsageDistribution: Record<string, number>;
  categoryBreakdown: AgentCategoryBreakdown[];
}

export interface AgentEvalConfig {
  scenarios: AgentScenario[];
  /** Server config for scenarios without an indexDir. Optional when all scenarios have indexDir set. */
  server?: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> };
  workspaceDir?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  maxConcurrency?: number;
  observer?: AgentEvalObserver;
  debug?: boolean;
  /** Run without docs-mcp server (baseline mode). The agent gets no MCP tools. */
  noMcp?: boolean;
}

export interface AgentEvalOutput {
  summary: AgentEvalSummary;
  results: AgentScenarioResult[];
  metadata: {
    model: string;
    startedAt: string;
    completedAt: string;
    totalDurationMs: number;
  };
}

export interface AgentObservedMessage {
  type: "system_init" | "assistant_text" | "tool_call" | "tool_result" | "result";
  summary: string;
  toolArgs?: Record<string, unknown>;
  toolResultPreview?: string;
  timestampMs: number;
}

export interface AgentEvalObserver {
  onScenarioStart(scenario: AgentScenario, index: number, total: number): void;
  onAgentMessage(scenario: AgentScenario, message: AgentObservedMessage): void;
  onScenarioComplete(scenario: AgentScenario, result: AgentScenarioResult): void;
  onEvalComplete(output: AgentEvalOutput): void;
}
