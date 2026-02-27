import { describe, expect, it } from "vitest";
import { mergeTaxonomyConfigs, parseManifest, resolveFileConfig } from "../src/manifest.js";
import type { Manifest } from "../src/types.js";

describe("manifest resolution", () => {
  it("uses last-match wins for overrides", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript" },
      overrides: [
        {
          pattern: "guides/**/*.md",
          metadata: { scope: "sdk-specific" },
        },
        {
          pattern: "guides/advanced/*.md",
          metadata: { scope: "global-guide" },
        },
      ],
    });

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/advanced/retries.md",
      manifest,
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide",
    });
  });

  it("applies frontmatter strategy and metadata as highest precedence", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript" },
    });

    const markdown = [
      "---",
      "mcp_chunking_hint: file",
      "mcp_metadata:",
      "  scope: global-guide",
      "---",
      "# Example",
    ].join("\n");

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/example.md",
      manifest,
      markdown,
    });

    expect(resolved.strategy.chunk_by).toBe("file");
    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide",
    });
  });

  it("supports metadata frontmatter object and merges with mcp_metadata", () => {
    const manifest = parseManifest({
      version: "1",
      strategy: { chunk_by: "h2" },
      metadata: { language: "typescript", product: "sdk" },
    });

    const markdown = [
      "---",
      "metadata:",
      "  scope: global-guide",
      "  product: docs",
      "mcp_metadata:",
      "  product: api",
      "---",
      "# Example",
    ].join("\n");

    const resolved = resolveFileConfig({
      relativeFilePath: "guides/example.md",
      manifest,
      markdown,
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "global-guide",
      product: "api",
    });
  });

  it("matches overrides relative to the manifest directory when provided", () => {
    const manifest = parseManifest({
      version: "1",
      metadata: { language: "typescript" },
      overrides: [
        {
          pattern: "auth.md",
          metadata: { scope: "sdk-specific" },
        },
      ],
    });

    const resolved = resolveFileConfig({
      relativeFilePath: "sdks/typescript/auth.md",
      manifestBaseDir: "sdks/typescript",
      manifest,
    });

    expect(resolved.metadata).toEqual({
      language: "typescript",
      scope: "sdk-specific",
    });
  });

  it("parses taxonomy config with vector_collapse", () => {
    const manifest = parseManifest({
      version: "1",
      metadata: { language: "typescript" },
      taxonomy: {
        language: { vector_collapse: true },
      },
    });

    expect(manifest.taxonomy).toEqual({
      language: { vector_collapse: true },
    });
  });

  it("parses taxonomy config without vector_collapse", () => {
    const manifest = parseManifest({
      version: "1",
      taxonomy: {
        language: {},
      },
    });

    expect(manifest.taxonomy).toEqual({ language: { vector_collapse: false } });
  });
});

describe("mergeTaxonomyConfigs", () => {
  it("returns empty when no manifests have taxonomy", () => {
    const manifests: Manifest[] = [
      { version: "1" },
      { version: "1", metadata: { scope: "global-guide" } },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({});
  });

  it("picks up vector_collapse from a single child manifest", () => {
    const manifests: Manifest[] = [
      { version: "1", metadata: { scope: "global-guide" } },
      {
        version: "1",
        metadata: { language: "python", scope: "sdk-specific" },
        taxonomy: { language: { vector_collapse: true } },
      },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({
      language: { vector_collapse: true },
    });
  });

  it("unions vector_collapse across multiple child manifests", () => {
    const manifests: Manifest[] = [
      {
        version: "1",
        metadata: { language: "python" },
        taxonomy: { language: { vector_collapse: true } },
      },
      {
        version: "1",
        metadata: { language: "typescript" },
        taxonomy: { language: { vector_collapse: true } },
      },
    ];

    const merged = mergeTaxonomyConfigs(manifests);
    expect(merged).toEqual({ language: { vector_collapse: true } });
  });

  it("propagates when only one of N manifests declares vector_collapse", () => {
    const manifests: Manifest[] = [
      { version: "1", metadata: { scope: "global-guide" } },
      {
        version: "1",
        metadata: { language: "python" },
        taxonomy: { language: { vector_collapse: true } },
      },
      { version: "1", metadata: { language: "go" } },
      { version: "1", metadata: { language: "typescript" } },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({
      language: { vector_collapse: true },
    });
  });

  it("merges different keys from different manifests", () => {
    const manifests: Manifest[] = [
      {
        version: "1",
        taxonomy: { language: { vector_collapse: true } },
      },
      {
        version: "1",
        taxonomy: { platform: { vector_collapse: true } },
      },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({
      language: { vector_collapse: true },
      platform: { vector_collapse: true },
    });
  });

  it("ignores manifests with taxonomy but no vector_collapse", () => {
    const manifests: Manifest[] = [
      {
        version: "1",
        taxonomy: { language: {} },
      },
      {
        version: "1",
        taxonomy: { language: { vector_collapse: false } },
      },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({});
  });

  it("merges properties with mcp_resource from multiple manifests", () => {
    const manifests: Manifest[] = [
      {
        version: "1",
        taxonomy: {
          language: {
            vector_collapse: true,
            properties: { typescript: { mcp_resource: true } },
          },
        },
      },
      {
        version: "1",
        taxonomy: {
          language: {
            vector_collapse: false,
            properties: { python: { mcp_resource: true } },
          },
        },
      },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({
      language: {
        vector_collapse: true,
        properties: {
          typescript: { mcp_resource: true },
          python: { mcp_resource: true },
        },
      },
    });
  });

  it("ignores properties with mcp_resource: false", () => {
    const manifests: Manifest[] = [
      {
        version: "1",
        taxonomy: {
          language: {
            vector_collapse: false,
            properties: { typescript: { mcp_resource: false } },
          },
        },
      },
    ];

    expect(mergeTaxonomyConfigs(manifests)).toEqual({});
  });

  it("parses taxonomy config with properties", () => {
    const manifest = parseManifest({
      version: "1",
      taxonomy: {
        language: {
          vector_collapse: true,
          properties: {
            typescript: { mcp_resource: true },
          },
        },
      },
    });

    expect(manifest.taxonomy).toEqual({
      language: {
        vector_collapse: true,
        properties: { typescript: { mcp_resource: true } },
      },
    });
  });
});
