import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider,
  AgentProviderConfig,
  AgentProviderEvent,
} from "./provider.js";

export class ClaudeAgentProvider implements AgentProvider {
  readonly name = "claude" as const;

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
        const msgUsage = message.message.usage as
          | Record<string, number>
          | undefined;

        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            yield {
              type: "text",
              text: block.text,
              ...(msgUsage
                ? {
                    usage: {
                      inputTokens: msgUsage.input_tokens ?? 0,
                      outputTokens: msgUsage.output_tokens ?? 0,
                      cacheReadInputTokens:
                        msgUsage.cache_read_input_tokens ?? 0,
                      cacheCreationInputTokens:
                        msgUsage.cache_creation_input_tokens ?? 0,
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

      if (message.type === "user" && message.tool_use_result != null) {
        const toolResult = message.tool_use_result as Record<string, unknown>;
        const toolUseId =
          typeof toolResult.tool_use_id === "string"
            ? toolResult.tool_use_id
            : undefined;

        if (toolUseId) {
          yield {
            type: "tool_result",
            id: toolUseId,
            result: extractToolResultText(toolResult),
          };
        }
      }

      if (message.type === "result") {
        const resultUsage = message.usage as Record<string, number>;
        yield {
          type: "done",
          subtype: message.subtype === "success" ? "success" : "error",
          answer: message.subtype === "success" ? message.result : "",
          errors:
            message.subtype === "success" ? [] : [...message.errors],
          usage: {
            inputTokens: resultUsage.input_tokens ?? 0,
            outputTokens: resultUsage.output_tokens ?? 0,
            cacheReadInputTokens:
              resultUsage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens:
              resultUsage.cache_creation_input_tokens ?? 0,
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
