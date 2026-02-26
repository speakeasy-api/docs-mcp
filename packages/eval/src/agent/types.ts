export interface AgentScenario {
  name: string;
  prompt: string;
  assertions: AgentAssertion[];
  category?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  /** Shell command run in workspace before agent starts */
  setup?: string;
  /** Path to docs directory. Resolved relative to scenario file. Runner auto-builds + caches the index. */
  docsDir?: string;
}

export type AgentAssertion =
  | { type: "contains"; value: string }
  | { type: "not_contains"; value: string }
  | { type: "matches"; pattern: string; flags?: string }
  | { type: "script"; command: string; name: string };

export interface AssertionResult {
  assertion: AgentAssertion;
  passed: boolean;
  message: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  timestampMs: number;
}

export interface AgentScenarioResult {
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
  toolUsageDistribution: Record<string, number>;
  categoryBreakdown: AgentCategoryBreakdown[];
}

export interface AgentEvalConfig {
  scenarios: AgentScenario[];
  server: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> };
  workspaceDir?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  maxConcurrency?: number;
  observer?: AgentEvalObserver;
  debug?: boolean;
  /** Resolved docsDir paths per scenario (keyed by scenario index). Set by bin.ts after resolving relative paths. */
  resolvedDocsDirs?: Map<number, string>;
  /** Path to CLI binary for building indexes */
  cliBinPath?: string;
  /** Path to server binary for auto-spawning */
  serverBinPath?: string;
  /** Cache directory for built indexes */
  cacheDir?: string;
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
