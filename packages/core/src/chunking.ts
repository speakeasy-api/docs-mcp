import { toString } from "mdast-util-to-string";
import type { Root, RootContent } from "mdast";
import type { BuildChunksInput, Chunk, ChunkingStrategy } from "./types.js";
import { parseMarkdown } from "./parser.js";

// ─── Internal types ──────────────────────────────────────────────

interface Segment {
  kind: "file" | "preamble" | "heading";
  heading: string;
  headingLevel: number;
  ancestorTexts: string[];
  ancestorSlugs: string[];
  slug: string;
  /** AST nodes belonging to this segment (used for content reconstruction and AST-safe splitting). */
  nodes: RootContent[];
  /** The full markdown source (needed to extract raw text via position offsets). */
  fullMarkdown: string;
  part: number;
}

interface HeadingBoundary {
  /** Index into ast.children where this heading appears. */
  childIndex: number;
  heading: string;
  headingLevel: number;
  ancestorTexts: string[];
  ancestorSlugs: string[];
  slug: string;
}

const CHUNK_LEVEL_MAP: Record<Exclude<ChunkingStrategy["chunk_by"], "file">, number> = {
  h1: 1,
  h2: 2,
  h3: 3
};

// ─── Public API ──────────────────────────────────────────────────

export function buildChunks(input: BuildChunksInput): Chunk[] {
  if (!input.filepath.trim()) {
    throw new Error("filepath is required");
  }

  const ast = parseMarkdown(input.markdown);

  if (input.strategy.chunk_by === "file") {
    const contentNodes = ast.children.filter((n) => n.type !== "yaml");
    const segments = applySizeRules(
      [
        {
          kind: "file",
          heading: "",
          headingLevel: 0,
          ancestorTexts: [],
          ancestorSlugs: [],
          slug: "",
          nodes: contentNodes,
          fullMarkdown: input.markdown,
          part: 1
        }
      ],
      input.strategy
    );
    return materializeChunks(input.filepath, segments, input.metadata ?? {});
  }

  const targetLevel = CHUNK_LEVEL_MAP[input.strategy.chunk_by];
  const segments = splitByHeadingLevel(ast, input.markdown, targetLevel);
  const adjusted = applySizeRules(segments, input.strategy);

  return materializeChunks(input.filepath, adjusted, input.metadata ?? {});
}

// ─── Heading-based splitting ─────────────────────────────────────

function splitByHeadingLevel(ast: Root, markdown: string, targetLevel: number): Segment[] {
  const boundaries: HeadingBoundary[] = [];
  const stack: Array<{ text: string; slug: string } | undefined> = new Array(7).fill(undefined);
  const slugCountsByParent = new Map<string, Map<string, number>>();

  // Filter out YAML frontmatter nodes for processing
  const contentChildren = ast.children.filter((n) => n.type !== "yaml");

  for (let childIdx = 0; childIdx < contentChildren.length; childIdx += 1) {
    const node = contentChildren[childIdx]!;
    if (node.type !== "heading") {
      continue;
    }

    const heading = toString(node).trim() || "section";
    const baseSlug = slugify(heading) || "section";

    const parentSlugs: string[] = [];
    for (let depth = 1; depth < node.depth; depth += 1) {
      const current = stack[depth];
      if (current) {
        parentSlugs.push(current.slug);
      }
    }

    const slug = dedupeSlug(parentSlugs, baseSlug, slugCountsByParent);
    stack[node.depth] = { text: heading, slug };
    for (let depth = node.depth + 1; depth < stack.length; depth += 1) {
      stack[depth] = undefined;
    }

    if (node.depth !== targetLevel) {
      continue;
    }

    const ancestorTexts: string[] = [];
    const ancestorSlugs: string[] = [];

    for (let depth = 1; depth < targetLevel; depth += 1) {
      const current = stack[depth];
      if (!current) {
        continue;
      }

      ancestorTexts.push(current.text);
      ancestorSlugs.push(current.slug);
    }

    boundaries.push({
      childIndex: childIdx,
      heading,
      headingLevel: node.depth,
      ancestorTexts,
      ancestorSlugs,
      slug
    });
  }

  if (boundaries.length === 0) {
    return [
      {
        kind: "preamble",
        heading: "",
        headingLevel: 0,
        ancestorTexts: [],
        ancestorSlugs: [],
        slug: "_preamble",
        nodes: contentChildren,
        fullMarkdown: markdown,
        part: 1
      }
    ];
  }

  const segments: Segment[] = [];

  // Preamble: nodes before the first target-level heading
  const preambleNodes = contentChildren.slice(0, boundaries[0]!.childIndex);
  if (preambleNodes.length > 0) {
    const preambleContent = rawMarkdown(preambleNodes, markdown);
    if (preambleContent.trim()) {
      segments.push({
        kind: "preamble",
        heading: "",
        headingLevel: 0,
        ancestorTexts: [],
        ancestorSlugs: [],
        slug: "_preamble",
        nodes: preambleNodes,
        fullMarkdown: markdown,
        part: 1
      });
    }
  }

  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    const next = boundaries[index + 1];
    const startIdx = boundary.childIndex;
    const endIdx = next ? next.childIndex : contentChildren.length;
    const sectionNodes = contentChildren.slice(startIdx, endIdx);

    const content = rawMarkdown(sectionNodes, markdown);
    if (!content.trim()) {
      continue;
    }

    segments.push({
      kind: "heading",
      heading: boundary.heading,
      headingLevel: boundary.headingLevel,
      ancestorTexts: boundary.ancestorTexts,
      ancestorSlugs: boundary.ancestorSlugs,
      slug: boundary.slug,
      nodes: sectionNodes,
      fullMarkdown: markdown,
      part: 1
    });
  }

  return segments.length > 0
    ? segments
    : [
        {
          kind: "preamble",
          heading: "",
          headingLevel: 0,
          ancestorTexts: [],
          ancestorSlugs: [],
          slug: "_preamble",
          nodes: contentChildren,
          fullMarkdown: markdown,
          part: 1
        }
      ];
}

// ─── Slug helpers ────────────────────────────────────────────────

function dedupeSlug(
  ancestorSlugs: string[],
  baseSlug: string,
  slugCountsByParent: Map<string, Map<string, number>>
): string {
  const parentPath = ancestorSlugs.join("/") || "__root__";
  const counterBySlug = slugCountsByParent.get(parentPath) ?? new Map<string, number>();
  slugCountsByParent.set(parentPath, counterBySlug);

  const count = (counterBySlug.get(baseSlug) ?? 0) + 1;
  counterBySlug.set(baseSlug, count);

  return count === 1 ? baseSlug : `${baseSlug}-${count}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── AST-safe size rules ─────────────────────────────────────────

function applySizeRules(segments: Segment[], strategy: ChunkingStrategy): Segment[] {
  const max = strategy.max_chunk_size;
  const min = strategy.min_chunk_size;

  // Phase 1: split oversized segments using AST node boundaries
  const expanded: Segment[] = [];

  for (const segment of segments) {
    const contentLength = rawMarkdown(segment.nodes, segment.fullMarkdown).length;

    if (!max || contentLength <= max) {
      expanded.push(segment);
      continue;
    }

    const nodeGroups = splitByNodeSize(segment.nodes, segment.fullMarkdown, max);
    nodeGroups.forEach((groupNodes, partIndex) => {
      expanded.push({
        ...segment,
        nodes: groupNodes,
        part: partIndex + 1
      });
    });
  }

  // Phase 2: merge undersized segments into previous (Opus-style breadcrumb check)
  if (!min || expanded.length <= 1) {
    return expanded;
  }

  const merged: Segment[] = [];
  for (const segment of expanded) {
    const previous = merged[merged.length - 1];
    const segmentContentLength = rawMarkdown(segment.nodes, segment.fullMarkdown).length;

    if (
      previous &&
      segmentContentLength < min &&
      canMerge(previous, segment)
    ) {
      // Merge nodes together
      previous.nodes = [...previous.nodes, ...segment.nodes];
      continue;
    }
    merged.push({ ...segment, nodes: [...segment.nodes] });
  }

  return merged;
}

/**
 * AST-safe max-size splitting (from Gemini approach).
 *
 * Iterates through AST nodes: if adding the next node would exceed the limit
 * AND we already have accumulated nodes, flush current accumulation as a sub-chunk.
 * Single nodes that exceed the limit on their own stay intact -- a large code
 * block is never bisected.
 */
function splitByNodeSize(nodes: RootContent[], fullMarkdown: string, maxSize: number): RootContent[][] {
  const groups: RootContent[][] = [];
  let current: RootContent[] = [];
  let currentSize = 0;

  for (const node of nodes) {
    const nodeSize = rawMarkdown([node], fullMarkdown).length;

    if (current.length > 0 && currentSize + nodeSize > maxSize) {
      groups.push(current);
      current = [node];
      currentSize = nodeSize;
    } else {
      current.push(node);
      currentSize += nodeSize;
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Determine whether a small segment can be merged into the previous one.
 *
 * Only merges segments that originated from the same heading section
 * (same slug, heading, heading level, and ancestor path). This prevents
 * merging across heading boundaries while allowing sub-chunk parts
 * (from max-size splitting) to be recombined.
 */
function canMerge(previous: Segment, current: Segment): boolean {
  if (previous.kind !== current.kind) {
    return false;
  }

  if (previous.slug !== current.slug) {
    return false;
  }

  if (previous.heading !== current.heading || previous.headingLevel !== current.headingLevel) {
    return false;
  }

  return ancestorSlugsMatch(previous.ancestorSlugs, current.ancestorSlugs);
}

function ancestorSlugsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ─── Chunk materialization ───────────────────────────────────────

function materializeChunks(
  filepath: string,
  segments: Segment[],
  metadata: Record<string, string>
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const [index, segment] of segments.entries()) {
    const chunkId = computeChunkId(filepath, segment);
    const breadcrumbParts = [filepath];

    if (segment.ancestorTexts.length > 0) {
      breadcrumbParts.push(...segment.ancestorTexts);
    }
    if (segment.heading) {
      breadcrumbParts.push(segment.heading);
    }

    const content = rawMarkdown(segment.nodes, segment.fullMarkdown);
    const contentText = segment.nodes.map((n) => toString(n)).join("\n\n");

    chunks.push({
      chunk_id: chunkId,
      filepath,
      heading: segment.heading,
      heading_level: segment.headingLevel,
      content,
      content_text: contentText,
      breadcrumb: breadcrumbParts.join(" > "),
      chunk_index: index,
      metadata: { ...metadata }
    });
  }

  return chunks;
}

function computeChunkId(filepath: string, segment: Segment): string {
  if (segment.kind === "file") {
    return segment.part === 1 ? filepath : `${filepath}#_part-${segment.part}`;
  }

  if (segment.kind === "preamble") {
    return segment.part === 1
      ? `${filepath}#_preamble`
      : `${filepath}#_preamble-part-${segment.part}`;
  }

  const partSuffix = segment.part > 1 ? `-part-${segment.part}` : "";
  const slug = `${segment.slug}${partSuffix}`;
  const fullPath = [...segment.ancestorSlugs, slug].join("/");
  return `${filepath}#${fullPath}`;
}

// ─── AST helpers ─────────────────────────────────────────────────

/**
 * Reconstruct raw markdown for a slice of AST nodes by extracting
 * the original source range from the full content string.
 * Falls back to mdast-util-to-string if position info is unavailable.
 */
function rawMarkdown(nodes: RootContent[], fullContent: string): string {
  if (nodes.length === 0) return "";

  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;

  if (first.position?.start && last.position?.end) {
    return fullContent.slice(
      first.position.start.offset,
      last.position.end.offset
    );
  }

  // Fallback
  return nodes.map((n) => toString(n)).join("\n\n");
}
