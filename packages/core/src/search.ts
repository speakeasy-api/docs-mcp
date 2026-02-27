import { decodeSearchCursor, encodeSearchCursor } from "./cursor.js";
import {
  clampLimit,
  dedupKey,
  isChunkIdFormat,
  makeSnippet,
  matchesMetadataFilters,
  normalizeSearchText,
  tokenizeSearchText,
} from "./search-common.js";
import type {
  Chunk,
  DocsIndexOptions,
  FileEntry,
  GetDocRequest,
  GetDocResult,
  ListFilepathsRequest,
  SearchEngine,
  SearchHit,
  SearchHint,
  SearchRequest,
  SearchResult,
} from "./types.js";

export class InMemorySearchEngine implements SearchEngine {
  private readonly chunks: Chunk[];
  private readonly byId: Map<string, Chunk>;
  private readonly byFile: Map<string, Chunk[]>;
  private readonly proximityWeight: number;
  private readonly collapseKeys: string[];

  constructor(chunks: Chunk[], options: DocsIndexOptions & { collapseKeys?: string[] } = {}) {
    this.chunks = [...chunks];
    this.byId = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
    this.byFile = new Map<string, Chunk[]>();
    this.proximityWeight = options.proximityWeight ?? 1.25;
    this.collapseKeys = options.collapseKeys ?? [];

    for (const chunk of chunks) {
      const list = this.byFile.get(chunk.filepath) ?? [];
      list.push(chunk);
      this.byFile.set(chunk.filepath, list);
    }

    for (const list of this.byFile.values()) {
      list.sort((a, b) => a.chunk_index - b.chunk_index);
    }
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const query = request.query.trim();
    if (!query) {
      throw new Error("query is required");
    }

    const limit = clampLimit(request.limit);
    const filters = request.filters ?? {};
    const offset = request.cursor
      ? decodeSearchCursor(request.cursor, { query, filters }).offset
      : 0;

    const taxonomyKeys = request.taxonomy_keys;
    const proximityWeight = request.rrf_weights?.phrase ?? this.proximityWeight;

    const scored = this.chunks
      .filter((chunk) => matchesMetadataFilters(chunk.metadata, filters, taxonomyKeys))
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, query, proximityWeight),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.chunk_id.localeCompare(b.chunk.chunk_id));

    const activeCollapseKeys = this.collapseKeys.filter((k) => !filters[k]);
    const deduped = deduplicateChunks(scored, activeCollapseKeys);

    const paged = deduped.slice(offset, offset + limit);
    const hits = paged.map(({ chunk, score }) => toSearchHit(chunk, score, query));

    const nextOffset = offset + paged.length;
    const nextCursor =
      nextOffset < deduped.length
        ? encodeSearchCursor({ offset: nextOffset, limit }, { query, filters })
        : null;

    if (hits.length > 0) {
      return {
        hits,
        next_cursor: nextCursor,
        hint: null,
      };
    }

    return {
      hits,
      next_cursor: nextCursor,
      hint: buildHint(this.chunks, query, filters),
    };
  }

  async getDoc(request: GetDocRequest): Promise<GetDocResult> {
    if (!isChunkIdFormat(request.chunk_id)) {
      throw new Error(
        `Chunk ID '${request.chunk_id}' has invalid format. Expected {filepath} or {filepath}#{heading-path}.`,
      );
    }

    const target = this.byId.get(request.chunk_id);
    if (!target) {
      throw new Error(
        `Chunk ID '${request.chunk_id}' not found. Use search_docs to discover valid chunk IDs.`,
      );
    }

    const fileChunks = this.byFile.get(target.filepath);
    if (!fileChunks) {
      throw new Error(`Internal error: file '${target.filepath}' is missing from index`);
    }

    if (request.context === -1) {
      return {
        text: fileChunks.map((chunk) => chunk.content).join("\n\n"),
      };
    }

    const context = Math.max(0, Math.min(5, request.context ?? 0));
    const indexInFile = fileChunks.findIndex((chunk) => chunk.chunk_id === target.chunk_id);
    const start = Math.max(0, indexInFile - context);
    const end = Math.min(fileChunks.length - 1, indexInFile + context);

    const blocks: string[] = [];
    for (let i = start; i <= end; i += 1) {
      const chunk = fileChunks[i];
      if (!chunk) {
        continue;
      }
      const positionLabel = `Chunk ${i + 1} of ${fileChunks.length}`;
      const contextOffset = i - indexInFile;
      const role =
        contextOffset === 0
          ? "Target"
          : `Context: ${contextOffset > 0 ? `+${contextOffset}` : contextOffset}`;

      blocks.push(
        `--- Chunk: ${chunk.chunk_id} (${positionLabel}) (${role}) ---\n${chunk.content}`,
      );
    }

    return {
      text: blocks.join("\n\n"),
    };
  }

  async listFilepaths(request: ListFilepathsRequest): Promise<FileEntry[]> {
    const filters = request.filters;
    const seen = new Set<string>();
    const entries: FileEntry[] = [];

    for (const chunk of this.chunks) {
      if (seen.has(chunk.filepath)) continue;
      let matches = true;
      for (const [key, value] of Object.entries(filters)) {
        if (chunk.metadata[key] !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      seen.add(chunk.filepath);
      const fileChunks = this.byFile.get(chunk.filepath);
      const firstChunk = fileChunks?.[0];
      entries.push({
        filepath: chunk.filepath,
        firstChunkId: firstChunk?.chunk_id ?? chunk.chunk_id,
      });
    }

    return entries.sort((a, b) => a.filepath.localeCompare(b.filepath));
  }
}

// Backwards-compatible alias while introducing the SearchEngine abstraction.
export class DocsIndex extends InMemorySearchEngine {}

function scoreChunk(chunk: Chunk, query: string, proximityWeight: number): number {
  const queryNormalized = normalizeSearchText(query);
  const tokens = tokenizeSearchText(queryNormalized);
  if (tokens.length === 0) {
    return 0;
  }

  const heading = normalizeSearchText(chunk.heading);
  const content = normalizeSearchText(chunk.content_text);

  let lexical = 0;
  for (const token of tokens) {
    lexical += countToken(content, token) + 3 * countToken(heading, token);
  }

  const phraseMatch = content.includes(queryNormalized) || heading.includes(queryNormalized);
  const proximityBoost = phraseMatch ? proximityWeight : 0;

  return lexical + proximityBoost;
}

function toSearchHit(chunk: Chunk, score: number, query: string): SearchHit {
  return {
    chunk_id: chunk.chunk_id,
    heading: chunk.heading,
    breadcrumb: chunk.breadcrumb,
    snippet: makeSnippet(chunk.content_text, query),
    filepath: chunk.filepath,
    metadata: chunk.metadata,
    score: Number(score.toFixed(6)),
  };
}

function buildHint(chunks: Chunk[], query: string, filters: Record<string, string>): SearchHint {
  const queryMatches = chunks.filter((chunk) => scoreChunk(chunk, query, 0) > 0);
  if (queryMatches.length === 0) {
    return {
      message: "0 results found. No matches were found for this query in the indexed corpus.",
      suggested_filters: {},
    };
  }

  const suggestions: Record<string, string[]> = {};
  for (const [key, activeValue] of Object.entries(filters)) {
    const values = new Set<string>();
    for (const chunk of queryMatches) {
      const candidate = chunk.metadata[key];
      if (!candidate || candidate === activeValue) {
        continue;
      }
      values.add(candidate);
    }

    if (values.size > 0) {
      suggestions[key] = [...values].sort((a, b) => a.localeCompare(b));
    }
  }

  const filterSummary = Object.entries(filters)
    .map(([key, value]) => `${key}='${value}'`)
    .join(", ");

  return {
    message: filterSummary
      ? `0 results found for query '${query}' with filters ${filterSummary}.`
      : `0 results found for query '${query}'.`,
    suggested_filters: suggestions,
  };
}

function deduplicateChunks(
  entries: Array<{ chunk: Chunk; score: number }>,
  collapseKeys: string[],
): Array<{ chunk: Chunk; score: number }> {
  if (collapseKeys.length === 0) return entries;

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = dedupKey(
      entry.chunk.filepath,
      entry.chunk.heading,
      entry.chunk.chunk_id,
      (k) => entry.chunk.metadata[k] ?? "",
      collapseKeys,
    );
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countToken(value: string, token: string): number {
  if (!token) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(token, index + token.length);
  }
  return count;
}
