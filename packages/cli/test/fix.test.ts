import { describe, expect, it } from "vitest";
import { buildHeuristicManifest, suggestChunkBy } from "../src/fix.js";

describe("suggestChunkBy", () => {
  it("returns file when no headings exist", () => {
    expect(suggestChunkBy("Plain prose without headings")).toBe("file");
  });

  it("prefers h2 when multiple h2 sections exist", () => {
    const markdown = ["# SDK", "", "## Installation", "content", "", "## Usage", "content"].join(
      "\n",
    );
    expect(suggestChunkBy(markdown)).toBe("h2");
  });

  it("chooses h3 when the file is highly nested", () => {
    const markdown = [
      "# Root",
      "## API",
      "### One",
      "### Two",
      "### Three",
      "### Four",
      "### Five",
      "### Six",
    ].join("\n");
    expect(suggestChunkBy(markdown)).toBe("h3");
  });
});

describe("buildHeuristicManifest", () => {
  it("builds overrides for outlier files", () => {
    const manifest = buildHeuristicManifest([
      {
        path: "docs/a.md",
        markdown: "## Intro\n\n## Config",
      },
      {
        path: "docs/b.md",
        markdown: "## Intro\n\n## Config",
      },
      {
        path: "docs/c.md",
        markdown: "No headings",
      },
    ]);

    expect(manifest.strategy?.chunk_by).toBe("h2");
    expect(manifest.overrides).toEqual([
      {
        pattern: "docs/c.md",
        strategy: {
          chunk_by: "file",
        },
      },
    ]);
  });
});
