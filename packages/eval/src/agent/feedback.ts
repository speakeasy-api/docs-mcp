import type { FeedbackResult, FeedbackToolConfig } from "./types.js";

export const DEFAULT_FEEDBACK_TOOL_CONFIG: FeedbackToolConfig = {
  name: "docs_feedback",
  description:
    "Submit structured feedback about how useful the documentation tools were for this task. Call this ONCE after you have finished using search_docs/get_doc and completed the task.",
  instruction:
    "After completing the task, call the docs_feedback tool to report how useful the documentation was.",
  inputSchema: {
    type: "object",
    properties: {
      confidence_score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "How confident are you that the documentation helped you produce a correct solution? (0=not at all, 100=completely)",
      },
      docs_relevance: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "How relevant was the retrieved documentation to the task? (0=irrelevant, 100=perfectly relevant)",
      },
      docs_utilization: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "How much of the documentation content did you incorporate into your solution? (0=none, 100=all)",
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of your assessment (1-2 sentences)",
      },
    },
    required: ["confidence_score", "docs_relevance", "docs_utilization", "reasoning"],
  },
  metrics: [
    { field: "confidence_score", label: "Confidence", direction: "higher" },
    { field: "docs_relevance", label: "Relevance", direction: "higher" },
    { field: "docs_utilization", label: "Utilization", direction: "higher" },
  ],
  reasoningField: "reasoning",
  headlineField: "confidence_score",
};

/**
 * Extract a FeedbackResult from raw tool call args using the given config.
 * Skips metric fields that are missing or non-numeric rather than failing entirely.
 * Returns undefined only if the tool call yielded no extractable data at all.
 */
export function parseFeedbackResult(
  args: Record<string, unknown>,
  config: FeedbackToolConfig,
): FeedbackResult | undefined {
  const scores: Record<string, number> = {};
  for (const metric of config.metrics) {
    const raw = Number(args[metric.field]);
    if (Number.isFinite(raw)) {
      scores[metric.field] = raw;
    }
  }

  let reasoning: string | undefined;
  if (config.reasoningField !== undefined) {
    const val = args[config.reasoningField];
    if (typeof val === "string") {
      reasoning = val;
    }
  }

  // Return undefined only if we extracted nothing at all
  if (Object.keys(scores).length === 0 && reasoning === undefined) {
    return undefined;
  }

  return {
    scores,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
