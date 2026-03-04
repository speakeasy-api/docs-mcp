import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, AgentProviderConfig, AgentProviderEvent } from "./provider.js";

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = "anthropic" as const;

  async *run(config: AgentProviderConfig): AsyncGenerator<AgentProviderEvent> {
    if (!config.model) {
      throw new Error("Claude provider requires a model to be specified");
    }

    for await (const message of query({
      prompt: config.prompt,
      options: {
        model: config.model,
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
        ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
        maxTurns: config.maxTurns,
        maxBudgetUsd: config.maxBudgetUsd,
        cwd: config.workspaceDir,
        env: config.env,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        const mcpServers = (message.mcp_servers ?? []) as Array<{
          name: string;
          status: string;
        }>;

        yield {
          type: "init",
          model: message.model as string,
          tools: message.tools as string[],
          mcpServers,
        };
      }

      if (message.type === "assistant") {
        const msgUsage = message.message.usage as Record<string, number> | undefined;

        let usageEmitted = false;
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            // Attach usage to the first text block only to avoid double-counting
            const includeUsage = msgUsage && !usageEmitted;
            usageEmitted = true;
            yield {
              type: "text",
              text: block.text,
              ...(includeUsage
                ? {
                    usage: {
                      inputTokens: msgUsage.input_tokens ?? 0,
                      outputTokens: msgUsage.output_tokens ?? 0,
                      cacheReadInputTokens: msgUsage.cache_read_input_tokens ?? 0,
                      cacheCreationInputTokens: msgUsage.cache_creation_input_tokens ?? 0,
                    },
                  }
                : {}),
            };
          }

          if (block.type === "tool_use") {
            yield {
              type: "tool_call",
              id: block.id,
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            };
          }
        }
      }

      if (message.type === "user") {
        const msg = message as Record<string, unknown>;

        // Primary path: the SDK sets tool_use_result + parent_tool_use_id
        if (msg.tool_use_result != null && typeof msg.parent_tool_use_id === "string") {
          yield {
            type: "tool_result",
            id: msg.parent_tool_use_id,
            result: extractToolResultText(msg.tool_use_result as Record<string, unknown>),
          };
        } else {
          // Fallback: extract tool_result blocks from the raw API message content
          const apiMsg = msg.message as { content?: unknown } | undefined;
          const content = apiMsg?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
                yield {
                  type: "tool_result",
                  id: block.tool_use_id,
                  result: extractToolResultText({ content: block.content } as Record<
                    string,
                    unknown
                  >),
                };
              }
            }
          }
        }
      }

      if (message.type === "result") {
        const resultUsage = message.usage as Record<string, number>;
        const isSuccess = message.subtype === "success";
        const errors: string[] = isSuccess ? [] : [...message.errors];

        // When the SDK reports an error with no details, synthesize a
        // human-readable reason from the subtype so callers always get
        // at least one actionable error string.
        if (!isSuccess && errors.length === 0) {
          const subtype = message.subtype as string;
          if (subtype === "error_max_budget_usd") {
            errors.push(`Budget limit reached ($${(message.total_cost_usd as number).toFixed(2)})`);
          } else if (subtype === "error_max_turns") {
            errors.push(`Max turns limit reached (${message.num_turns as number} turns)`);
          } else {
            errors.push(`Agent stopped: ${subtype.replace(/_/g, " ")}`);
          }
        }

        yield {
          type: "done",
          subtype: isSuccess ? "success" : "error",
          answer: isSuccess ? message.result : "",
          errors,
          usage: {
            inputTokens: resultUsage.input_tokens ?? 0,
            outputTokens: resultUsage.output_tokens ?? 0,
            cacheReadInputTokens: resultUsage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: resultUsage.cache_creation_input_tokens ?? 0,
            totalCostUsd: message.total_cost_usd,
            durationApiMs: message.duration_api_ms,
            numTurns: message.num_turns,
          },
        };
      }
    }
  }
}

function extractToolResultText(toolResult: Record<string, unknown>): string {
  if (typeof toolResult.content === "string") return toolResult.content;
  if (Array.isArray(toolResult.content)) {
    return (toolResult.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return JSON.stringify(toolResult);
}
