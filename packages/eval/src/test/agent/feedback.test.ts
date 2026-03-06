import { describe, expect, it } from "vitest";
import { DEFAULT_FEEDBACK_TOOL_CONFIG, parseFeedbackResult } from "../../agent/feedback.js";
import type { FeedbackToolConfig } from "../../agent/types.js";

const customConfig: FeedbackToolConfig = {
  name: "give_feedback",
  description: "Submit feedback",
  instruction: "Call give_feedback after completing the task.",
  inputSchema: {
    type: "object",
    properties: {
      feedback: { type: "string" },
      rating: { type: "integer", minimum: 1, maximum: 5 },
      chunk_id: { type: "string" },
    },
    required: ["feedback"],
  },
  metrics: [{ field: "rating", label: "Rating", direction: "higher" }],
  reasoningField: "feedback",
  headlineField: "rating",
};

describe("parseFeedbackResult", () => {
  it("extracts all fields when present", () => {
    const result = parseFeedbackResult(
      { feedback: "Great docs", rating: 4, chunk_id: "abc" },
      customConfig,
    );
    expect(result).toEqual({ scores: { rating: 4 }, reasoning: "Great docs" });
  });

  it("extracts reasoning even when metric is missing", () => {
    const result = parseFeedbackResult({ feedback: "Helpful docs" }, customConfig);
    expect(result).toEqual({ scores: {}, reasoning: "Helpful docs" });
  });

  it("returns undefined when no data is extractable", () => {
    const result = parseFeedbackResult({}, customConfig);
    expect(result).toBeUndefined();
  });

  it("extracts scores even when reasoning field is missing", () => {
    const result = parseFeedbackResult({ rating: 3 }, customConfig);
    expect(result).toEqual({ scores: { rating: 3 } });
  });

  it("coerces string numbers to numeric scores", () => {
    const result = parseFeedbackResult({ feedback: "ok", rating: "5" }, customConfig);
    expect(result).toEqual({ scores: { rating: 5 }, reasoning: "ok" });
  });

  it("skips non-numeric metric values instead of failing", () => {
    const result = parseFeedbackResult({ feedback: "test", rating: "not a number" }, customConfig);
    expect(result).toEqual({ scores: {}, reasoning: "test" });
  });

  it("works with default config when all fields present", () => {
    const result = parseFeedbackResult(
      {
        confidence_score: 85,
        docs_relevance: 90,
        docs_utilization: 70,
        reasoning: "Docs were helpful",
      },
      DEFAULT_FEEDBACK_TOOL_CONFIG,
    );
    expect(result).toEqual({
      scores: { confidence_score: 85, docs_relevance: 90, docs_utilization: 70 },
      reasoning: "Docs were helpful",
    });
  });

  it("extracts partial metrics with default config", () => {
    const result = parseFeedbackResult(
      { confidence_score: 80, reasoning: "Partial feedback" },
      DEFAULT_FEEDBACK_TOOL_CONFIG,
    );
    expect(result).toEqual({
      scores: { confidence_score: 80 },
      reasoning: "Partial feedback",
    });
  });
});
