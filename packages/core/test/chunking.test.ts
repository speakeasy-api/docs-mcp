import { describe, expect, it } from "vitest";
import { buildChunks } from "../src/chunking.js";

describe("buildChunks", () => {
  it("creates deterministic chunk IDs and resolves duplicates", () => {
    const markdown = [
      "# Auth",
      "",
      "## Login",
      "first",
      "",
      "## Login",
      "second",
      "",
      "# Billing",
      "",
      "## Retry",
      "third"
    ].join("\n");

    const chunks = buildChunks({
      filepath: "guides/example.md",
      markdown,
      strategy: { chunk_by: "h2" }
    });

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "guides/example.md#_preamble",
      "guides/example.md#auth/login",
      "guides/example.md#auth/login-2",
      "guides/example.md#billing/retry"
    ]);
  });

  it("creates a preamble chunk when content exists before first heading", () => {
    const markdown = ["intro", "", "## First", "body"].join("\n");

    const chunks = buildChunks({
      filepath: "guides/preamble.md",
      markdown,
      strategy: { chunk_by: "h2" }
    });

    expect(chunks[0]?.chunk_id).toBe("guides/preamble.md#_preamble");
    expect(chunks[1]?.chunk_id).toBe("guides/preamble.md#first");
  });

  it("uses deduplicated parent slugs for descendants under duplicated headings", () => {
    const markdown = [
      "# Examples",
      "",
      "## Setup",
      "first setup",
      "",
      "# Examples",
      "",
      "## Setup",
      "second setup"
    ].join("\n");

    const chunks = buildChunks({
      filepath: "guides/examples.md",
      markdown,
      strategy: { chunk_by: "h2" }
    });

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "guides/examples.md#_preamble",
      "guides/examples.md#examples/setup",
      "guides/examples.md#examples-2/setup"
    ]);
  });

  it("keeps fenced code content in content_text for FTS", () => {
    const markdown = ["## Usage", "```ts", "client.users.list()", "```"].join("\n");
    const chunks = buildChunks({
      filepath: "guides/code.md",
      markdown,
      strategy: { chunk_by: "h2" }
    });

    expect(chunks[0]?.content_text).toContain("client.users.list()");
  });

  it("does not merge tiny chunks across different heading boundaries", () => {
    const markdown = ["## One", "small", "", "## Two", "tiny"].join("\n");
    const chunks = buildChunks({
      filepath: "guides/min-merge.md",
      markdown,
      strategy: { chunk_by: "h2", min_chunk_size: 100 }
    });

    expect(chunks.map((chunk) => chunk.chunk_id)).toEqual([
      "guides/min-merge.md#one",
      "guides/min-merge.md#two"
    ]);
  });

  it("merges undersized split parts only within the same segment", () => {
    const markdown = [
      "## One",
      "This paragraph is intentionally long enough to force a split.",
      "",
      "tiny"
    ].join("\n");

    const chunks = buildChunks({
      filepath: "guides/min-merge-parts.md",
      markdown,
      strategy: { chunk_by: "h2", max_chunk_size: 70, min_chunk_size: 20 }
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_id).toBe("guides/min-merge-parts.md#one");
    expect(chunks[0]?.content).toContain("tiny");
  });
});
