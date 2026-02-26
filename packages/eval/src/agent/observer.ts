import type {
  AgentEvalObserver,
  AgentEvalOutput,
  AgentObservedMessage,
  AgentScenario,
  AgentScenarioResult
} from "./types.js";

const useColor = !process.env.NO_COLOR;

const colors = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : ""
};

function write(text: string): void {
  process.stderr.write(text);
}

export class ConsoleObserver implements AgentEvalObserver {
  onScenarioStart(scenario: AgentScenario, index: number, total: number): void {
    write(
      `\n${colors.bold}${colors.cyan}━━━ Scenario ${index + 1}/${total}: ${scenario.name} ━━━${colors.reset}\n`
    );
    if (scenario.category) {
      write(`${colors.dim}Category: ${scenario.category}${colors.reset}\n`);
    }
    write(`${colors.dim}Prompt: ${scenario.prompt.slice(0, 120)}${scenario.prompt.length > 120 ? "..." : ""}${colors.reset}\n`);
  }

  onAgentMessage(scenario: AgentScenario, message: AgentObservedMessage): void {
    const ts = `${colors.dim}[${(message.timestampMs / 1000).toFixed(1)}s]${colors.reset}`;

    switch (message.type) {
      case "system_init":
        write(`${ts} ${colors.blue}▶ ${message.summary}${colors.reset}\n`);
        break;
      case "assistant_text":
        write(`${ts} ${colors.magenta}◆ ${message.summary}${colors.reset}\n`);
        break;
      case "tool_call":
        write(`${ts} ${colors.yellow}⚡ ${message.summary}${colors.reset}\n`);
        break;
      case "tool_result":
        write(`${ts} ${colors.dim}  ↳ ${message.toolResultPreview ?? message.summary}${colors.reset}\n`);
        break;
      case "result":
        write(`${ts} ${colors.bold}■ ${message.summary}${colors.reset}\n`);
        break;
    }
  }

  onScenarioComplete(_scenario: AgentScenario, result: AgentScenarioResult): void {
    const status = result.passed
      ? `${colors.green}✓ PASSED${colors.reset}`
      : `${colors.red}✗ FAILED${colors.reset}`;

    write(`\n${status} ${colors.bold}${result.name}${colors.reset}\n`);
    write(
      `${colors.dim}  Turns: ${result.numTurns} | Cost: $${result.totalCostUsd.toFixed(4)} | Duration: ${(result.durationMs / 1000).toFixed(1)}s | Tokens: ${result.inputTokens}in/${result.outputTokens}out${colors.reset}\n`
    );

    if (result.activated) {
      write(`${colors.dim}  Docs-MCP activated: yes${colors.reset}\n`);
    } else {
      write(`${colors.yellow}  Docs-MCP activated: no${colors.reset}\n`);
    }

    for (const ar of result.assertionResults) {
      const icon = ar.passed ? `${colors.green}✓` : `${colors.red}✗`;
      write(`  ${icon} ${ar.message}${colors.reset}\n`);
    }

    if (result.errors?.length) {
      for (const e of result.errors) {
        write(`  ${colors.red}⚠ ${e}${colors.reset}\n`);
      }
    }
  }

  onEvalComplete(output: AgentEvalOutput): void {
    const s = output.summary;
    write(`\n${colors.bold}${colors.cyan}━━━ Agent Eval Summary ━━━${colors.reset}\n`);
    write(`  Scenarios:      ${s.totalScenarios}\n`);
    write(`  Pass rate:      ${(s.passRate * 100).toFixed(1)}%\n`);
    write(`  Activation:     ${(s.activationRate * 100).toFixed(1)}%\n`);
    write(`  Avg turns:      ${s.avgTurns.toFixed(1)} (median ${s.medianTurns})\n`);
    write(`  Avg cost:       $${s.avgCostUsd.toFixed(4)} (total $${s.totalCostUsd.toFixed(4)})\n`);
    write(`  Avg duration:   ${(s.avgDurationMs / 1000).toFixed(1)}s (median ${(s.medianDurationMs / 1000).toFixed(1)}s)\n`);
    write(`  Avg tokens:     ${s.avgInputTokens.toFixed(0)}in / ${s.avgOutputTokens.toFixed(0)}out\n`);

    if (s.categoryBreakdown.length > 0) {
      write(`\n${colors.bold}  Category Breakdown:${colors.reset}\n`);
      for (const cat of s.categoryBreakdown) {
        write(
          `    ${cat.category}: ${cat.scenarioCount} scenarios, ${(cat.passRate * 100).toFixed(0)}% pass, ${(cat.activationRate * 100).toFixed(0)}% activation\n`
        );
      }
    }

    write("\n");
  }
}

export class NoopObserver implements AgentEvalObserver {
  onScenarioStart(): void {}
  onAgentMessage(): void {}
  onScenarioComplete(): void {}
  onEvalComplete(): void {}
}
