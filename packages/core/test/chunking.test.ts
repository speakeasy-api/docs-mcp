import { describe, expect, it } from "vitest";
import { buildChunks, DEFAULT_MAX_CHUNK_SIZE } from "../src/chunking.js";

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

  describe("recursive heading refinement", () => {
    const bigBody = (chars: number) => "x".repeat(chars);

    it("splits oversized h2 at h3 sub-heading boundaries", () => {
      const markdown = [
        "## Authentication",
        bigBody(50),
        "",
        "### OAuth",
        bigBody(50),
        "",
        "### JWT",
        bigBody(50),
        "",
        "### API Keys",
        bigBody(50)
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/auth.md",
        markdown,
        strategy: { chunk_by: "h2", max_chunk_size: 100 }
      });

      const ids = chunks.map((c) => c.chunk_id);
      // Preamble content before the first h3 inherits the parent heading
      expect(ids).toContain("docs/auth.md#authentication");
      // Sub-headings get proper nested IDs
      expect(ids).toContain("docs/auth.md#authentication/oauth");
      expect(ids).toContain("docs/auth.md#authentication/jwt");
      expect(ids).toContain("docs/auth.md#authentication/api-keys");

      // Sub-chunks have correct breadcrumbs
      const oauthChunk = chunks.find((c) => c.chunk_id === "docs/auth.md#authentication/oauth");
      expect(oauthChunk?.breadcrumb).toBe("docs/auth.md > Authentication > OAuth");
      expect(oauthChunk?.heading).toBe("OAuth");
      expect(oauthChunk?.heading_level).toBe(3);
    });

    it("recursively refines h2 > h3 > h4 when multiple levels are oversized", () => {
      const markdown = [
        "## Config",
        bigBody(50),
        "",
        "### Advanced",
        bigBody(50),
        "",
        "#### Timeouts",
        bigBody(50),
        "",
        "#### Retries",
        bigBody(50)
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/config.md",
        markdown,
        strategy: { chunk_by: "h2", max_chunk_size: 100 }
      });

      const ids = chunks.map((c) => c.chunk_id);
      expect(ids).toContain("docs/config.md#config");
      expect(ids).toContain("docs/config.md#config/advanced");
      expect(ids).toContain("docs/config.md#config/advanced/timeouts");
      expect(ids).toContain("docs/config.md#config/advanced/retries");

      // Verify deep breadcrumbs
      const timeouts = chunks.find((c) => c.chunk_id === "docs/config.md#config/advanced/timeouts");
      expect(timeouts?.breadcrumb).toBe("docs/config.md > Config > Advanced > Timeouts");
    });

    it("falls back to AST node splitting when no sub-headings exist", () => {
      const markdown = [
        "## Huge Section",
        "Paragraph one. " + bigBody(80),
        "",
        "Paragraph two. " + bigBody(80)
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/huge.md",
        markdown,
        strategy: { chunk_by: "h2", max_chunk_size: 100 }
      });

      // Should produce multiple parts since there are no sub-headings
      expect(chunks.length).toBeGreaterThan(1);
      // All parts share the same base slug with part suffixes
      expect(chunks[0]?.chunk_id).toBe("docs/huge.md#huge-section");
      expect(chunks[1]?.chunk_id).toBe("docs/huge.md#huge-section-part-2");
    });

    it("applies DEFAULT_MAX_CHUNK_SIZE when no explicit max_chunk_size is set", () => {
      // Create a chunk that exceeds DEFAULT_MAX_CHUNK_SIZE
      const markdown = [
        "## Giant",
        bigBody(DEFAULT_MAX_CHUNK_SIZE + 1000),
        "",
        "## Small",
        "tiny"
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/giant.md",
        markdown,
        strategy: { chunk_by: "h2" }
      });

      // The giant section should be split even without explicit max_chunk_size
      const giantChunks = chunks.filter((c) => c.chunk_id.startsWith("docs/giant.md#giant"));
      expect(giantChunks.length).toBeGreaterThan(1);
    });

    it("preserves preamble content within a refined section", () => {
      const markdown = [
        "## Parent",
        "This is the preamble before any h3.",
        "",
        "### Child One",
        bigBody(80),
        "",
        "### Child Two",
        bigBody(80)
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/preamble-refine.md",
        markdown,
        strategy: { chunk_by: "h2", max_chunk_size: 100 }
      });

      // Preamble content should be preserved in a chunk with the parent heading
      const parentChunk = chunks.find((c) => c.chunk_id === "docs/preamble-refine.md#parent");
      expect(parentChunk).toBeDefined();
      expect(parentChunk?.content).toContain("preamble before any h3");

      // Sub-heading chunks should also exist
      const ids = chunks.map((c) => c.chunk_id);
      expect(ids).toContain("docs/preamble-refine.md#parent/child-one");
      expect(ids).toContain("docs/preamble-refine.md#parent/child-two");
    });

    it("deduplicates slugs within a refined section", () => {
      const markdown = [
        "## Parent",
        "",
        "### Example",
        bigBody(80),
        "",
        "### Example",
        bigBody(80)
      ].join("\n");

      const chunks = buildChunks({
        filepath: "docs/dedup.md",
        markdown,
        strategy: { chunk_by: "h2", max_chunk_size: 100 }
      });

      const ids = chunks.map((c) => c.chunk_id);
      expect(ids).toContain("docs/dedup.md#parent/example");
      expect(ids).toContain("docs/dedup.md#parent/example-2");
    });
  });
});
