import type { ChunkingStrategy, Manifest } from "@speakeasy-api/docs-mcp-core";

export interface FixFileInput {
  path: string;
  markdown: string;
}

export function buildHeuristicManifest(files: FixFileInput[]): Manifest {
  if (files.length === 0) {
    return {
      version: "1",
      strategy: { chunk_by: "h2" }
    };
  }

  const suggestions = files.map((file) => ({
    path: file.path,
    chunkBy: suggestChunkBy(file.markdown)
  }));
  const defaultChunkBy = pickDefaultChunkBy(suggestions.map((entry) => entry.chunkBy));
  const overrides = suggestions
    .filter((entry) => entry.chunkBy !== defaultChunkBy)
    .map((entry) => ({
      pattern: entry.path,
      strategy: {
        chunk_by: entry.chunkBy
      }
    }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));

  const manifest: Manifest = {
    version: "1",
    strategy: {
      chunk_by: defaultChunkBy
    }
  };
  if (overrides.length > 0) {
    manifest.overrides = overrides;
  }

  return manifest;
}

export function suggestChunkBy(markdown: string): ChunkingStrategy["chunk_by"] {
  const stripped = stripFencedCodeBlocks(markdown);
  const headingCounts = countHeadings(stripped);
  const totalHeadings = headingCounts.h1 + headingCounts.h2 + headingCounts.h3;

  if (totalHeadings === 0) {
    return "file";
  }

  if (headingCounts.h3 >= 6 && headingCounts.h3 >= headingCounts.h2 * 2) {
    return "h3";
  }

  if (headingCounts.h2 >= 2) {
    return "h2";
  }

  if (headingCounts.h1 >= 2) {
    return "h1";
  }

  if (headingCounts.h3 >= 2) {
    return "h3";
  }

  return "file";
}

function pickDefaultChunkBy(values: ChunkingStrategy["chunk_by"][]): ChunkingStrategy["chunk_by"] {
  const counts = new Map<ChunkingStrategy["chunk_by"], number>([
    ["h2", 0],
    ["h1", 0],
    ["h3", 0],
    ["file", 0]
  ]);

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let best: ChunkingStrategy["chunk_by"] = "h2";
  let bestCount = -1;
  for (const candidate of ["h2", "h1", "h3", "file"] as const) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

function countHeadings(markdown: string): { h1: number; h2: number; h3: number } {
  const counts = { h1: 0, h2: 0, h3: 0 };
  const lines = markdown.split(/\r?\n/g);
  for (const line of lines) {
    const match = /^\s{0,3}(#{1,3})\s+\S+/.exec(line);
    if (!match) {
      continue;
    }
    const level = match[1]!.length;
    if (level === 1) {
      counts.h1 += 1;
    } else if (level === 2) {
      counts.h2 += 1;
    } else if (level === 3) {
      counts.h3 += 1;
    }
  }
  return counts;
}

function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}
