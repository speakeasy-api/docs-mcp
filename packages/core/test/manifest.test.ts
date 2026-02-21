import { describe, expect, it } from "vitest";
import { parseManifest, resolveFileConfig } from "../src/manifest.js";

describe("manifest resolution", () => {
  it("uses last-match wins for overrides", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript" },
      overrides: [
        {
          pattern: "guides/**/*.md",
          metadata: { scope: "sdk-specific" }
        },
        {
          pattern: "guides/advanced/*.md",
          metadata: { scope: "global-guide" }
        }
      ]
    });

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/advanced/retries.md",
      manifest
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide"
    });
  });

  it("applies frontmatter strategy and metadata as highest precedence", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript" }
    });

    const markdown = [
      "---",
      "mcp_chunking_hint: file",
      "mcp_metadata:",
      "  scope: global-guide",
      "---",
      "# Example"
    ].join("\n");

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/example.md",
      manifest,
      markdown
    });

    expect(resolved.strategy.chunk_by).toBe("file");
    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide"
    });
  });

  it("supports metadata frontmatter object and merges with mcp_metadata", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript", product: "sdk" }
    });

    const markdown = [
      "---",
      "metadata:",
      "  scope: global-guide",
      "  product: docs",
      "mcp_metadata:",
      "  product: api",
      "---",
      "# Example"
    ].join("\n");

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/example.md",
      manifest,
      markdown
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide",
      product: "api"
    });
  });

  it("matches overrides relative to the manifest directory when provided", () => {
    const manifest = parseManifest({
      version: "1",
      metadata: { language: "typescript" },
      overrides: [
        {
          pattern: "auth.md",
          metadata: { scope: "sdk-specific" }
        }
      ]
    });

    const resolved = resolveFileConfig({
      relativeFilePath: "sdks/typescript/auth.md",
      manifestBaseDir: "sdks/typescript",
      manifest
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "sdk-specific"
    });
  });
});
