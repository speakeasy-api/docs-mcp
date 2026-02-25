import {
  connect,
  Index,
  MultiMatchQuery,
  PhraseQuery,
  type FullTextQuery,
  type Table
} from "@lancedb/lancedb";
import { decodeSearchCursor, encodeSearchCursor } from "./cursor.js";
import {
  clampLimit,
  dedupKey,
  isChunkIdFormat,
  makeSnippet
} from "./search-common.js";
import type {
  Chunk,
  DocsIndexOptions,
  EmbeddingProvider,
  GetDocRequest,
  GetDocResult,
  SearchEngine,
  SearchHint,
  SearchHit,
  SearchRequest,
  SearchResult
} from "./types.js";

const DEFAULT_TABLE_NAME = "chunks";
const RRF_K = 60;

export interface BuildLanceDbIndexOptions {
  dbPath: string;
  chunks: Chunk[];
  tableName?: string;
  metadataKeys?: string[];
  vectorsByChunkId?: Map<string, number[]>;
  fileFingerprints?: Record<string, string>;
  onProgress?: (step: IndexBuildStep) => void;
}

export type IndexBuildStep =
  | "writing-table"
  | "indexing-fts"
  | "indexing-scalar"
  | "indexing-vector";

export interface OpenLanceDbSearchEngineOptions {
  dbPath: string;
  tableName?: string;
  metadataKeys: string[];
  collapseKeys?: string[];
  proximityWeight?: number;
  phraseSlop?: number;
  queryEmbeddingProvider?: EmbeddingProvider;
  vectorWeight?: number;
  onWarning?: (message: string) => void;
}

export interface LanceDbIndexBuildResult {
  tableName: string;
  metadataKeys: string[];
}

export async function buildLanceDbIndex(
  options: BuildLanceDbIndexOptions
): Promise<LanceDbIndexBuildResult> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  const metadataKeys = options.metadataKeys ?? collectMetadataKeys(options.chunks);

  const rows = options.chunks.map((chunk) =>
    serializeChunkRow(chunk, metadataKeys, options.vectorsByChunkId, options.fileFingerprints)
  );

  if (rows.length === 0) {
    return { tableName, metadataKeys };
  }

  const onProgress = options.onProgress;

  const db = await connect(options.dbPath);

  try {
    onProgress?.("writing-table");
    const table = await db.createTable(tableName, rows, { mode: "overwrite" });

    onProgress?.("indexing-fts");
    await table.createIndex("content_text", {
      config: Index.fts({ withPosition: true }),
      replace: true
    });
    await table.createIndex("heading", {
      config: Index.fts({ withPosition: true }),
      replace: true
    });

    onProgress?.("indexing-scalar");
    await Promise.all([
      safeCreateScalarIndex(table, "chunk_id"),
      safeCreateScalarIndex(table, "filepath"),
      safeCreateScalarIndex(table, "chunk_index")
    ]);

    // Create IVF-PQ vector index when there are enough rows with vectors
    if (options.vectorsByChunkId && options.vectorsByChunkId.size >= 256) {
      onProgress?.("indexing-vector");
      const numPartitions = Math.max(1, Math.round(Math.sqrt(options.vectorsByChunkId.size)));
      try {
        await table.createIndex("vector", {
          config: Index.ivfPq({ numPartitions }),
          replace: true,
        });
      } catch {
        // Non-fatal: brute-force vector search still works without the index
      }
    }

    table.close();
  } finally {
    db.close();
  }

  return {
    tableName,
    metadataKeys
  };
}

export class LanceDbSearchEngine implements SearchEngine {
  private readonly table: Table;
  private readonly metadataKeys: string[];
  private readonly collapseKeys: string[];
  private readonly proximityWeight: number;
  private readonly phraseSlop: number;
  private readonly queryEmbeddingProvider: EmbeddingProvider | undefined;
  private readonly vectorWeight: number;
  private readonly onWarning: (message: string) => void;
  private hasWarnedVectorFailure = false;

  private constructor(
    table: Table,
    metadataKeys: string[],
    options: DocsIndexOptions & {
      collapseKeys?: string[];
      queryEmbeddingProvider?: EmbeddingProvider;
      vectorWeight?: number;
      onWarning?: (message: string) => void;
    } = {}
  ) {
    this.table = table;
    this.metadataKeys = [...metadataKeys];
    this.collapseKeys = options.collapseKeys ?? [];
    this.proximityWeight = options.proximityWeight ?? 1.25;
    this.phraseSlop = normalizePhraseSlop(options.phraseSlop);
    this.queryEmbeddingProvider = options.queryEmbeddingProvider;
    this.vectorWeight = options.vectorWeight ?? 1;
    this.onWarning = options.onWarning ?? ((message: string) => console.warn(`warn: ${message}`));
  }

  static async open(options: OpenLanceDbSearchEngineOptions): Promise<LanceDbSearchEngine> {
    const db = await connect(options.dbPath);
    const table = await db.openTable(options.tableName ?? DEFAULT_TABLE_NAME);
    const engineOptions: DocsIndexOptions & {
      collapseKeys?: string[];
      queryEmbeddingProvider?: EmbeddingProvider;
      vectorWeight?: number;
      onWarning?: (message: string) => void;
    } = {};
    if (options.collapseKeys !== undefined) {
      engineOptions.collapseKeys = options.collapseKeys;
    }
    if (options.proximityWeight !== undefined) {
      engineOptions.proximityWeight = options.proximityWeight;
    }
    if (options.phraseSlop !== undefined) {
      engineOptions.phraseSlop = options.phraseSlop;
    }
    if (options.queryEmbeddingProvider !== undefined) {
      engineOptions.queryEmbeddingProvider = options.queryEmbeddingProvider;
    }
    if (options.vectorWeight !== undefined) {
      engineOptions.vectorWeight = options.vectorWeight;
    }
    if (options.onWarning !== undefined) {
      engineOptions.onWarning = options.onWarning;
    }

    return new LanceDbSearchEngine(table, options.metadataKeys, engineOptions);
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
    const whereClause = buildWhereClause(filters, request.taxonomy_keys);
    const fetchLimit = Math.min(Math.max(offset + limit + 200, limit * 5), 5000);

    const [matchRows, phraseRows, vectorRows] = await Promise.all([
      this.runFtsQuery(
        new MultiMatchQuery(query, ["heading", "content_text"], { boosts: [3, 1] }),
        whereClause,
        fetchLimit
      ),
      this.runFtsQuery(
        new PhraseQuery(query, "content_text", { slop: this.phraseSlop }),
        whereClause,
        fetchLimit
      ),
      this.runVectorQuery(query, whereClause, fetchLimit)
    ]);

    const matchWeight = request.rrf_weights?.match ?? 1;
    const phraseWeight = request.rrf_weights?.phrase ?? this.proximityWeight;
    const vecWeight = request.rrf_weights?.vector ?? this.vectorWeight;
    const blended = blendRows(matchRows, phraseRows, vectorRows, phraseWeight, vecWeight, matchWeight);

    // Collapse content-equivalent results across variant axes (e.g. same
    // operation documented in multiple SDK languages). Skipped when active
    // filters already restrict every collapse axis to a single value.
    const activeCollapseKeys = this.collapseKeys.filter((k) => !filters[k]);
    const deduped = deduplicateRows(blended, activeCollapseKeys);

    const paged = deduped.slice(offset, offset + limit);

    const hits = paged.map((entry) =>
      toSearchHit(entry.row, entry.score, query, this.metadataKeys)
    );

    const nextOffset = offset + paged.length;
    const nextCursor = nextOffset < deduped.length
      ? encodeSearchCursor({ offset: nextOffset, limit }, { query, filters })
      : null;

    if (hits.length > 0) {
      return {
        hits,
        next_cursor: nextCursor,
        hint: null
      };
    }

    return {
      hits,
      next_cursor: nextCursor,
      hint: await this.buildHint(query, filters)
    };
  }

  async getDoc(request: GetDocRequest): Promise<GetDocResult> {
    if (!isChunkIdFormat(request.chunk_id)) {
      throw new Error(
        `Chunk ID '${request.chunk_id}' has invalid format. Expected {filepath} or {filepath}#{heading-path}.`
      );
    }

    const context = Math.max(0, Math.min(5, request.context ?? 0));

    const targetRows = await this.table
      .query()
      .where(`chunk_id = '${escapeSqlString(request.chunk_id)}'`)
      .limit(1)
      .toArray();

    if (targetRows.length === 0) {
      throw new Error(
        `Chunk ID '${request.chunk_id}' not found. Use search_docs to discover valid chunk IDs.`
      );
    }

    const target = targetRows[0] as ChunkRow;
    const filepath = expectStringField(target, "filepath");
    const targetIndex = toNumberField(target, "chunk_index");

    const minIndex = Math.max(0, targetIndex - context);
    const maxIndex = targetIndex + context;

    // Fetch only the needed range using BETWEEN for efficiency
    const escapedFilepath = escapeSqlString(filepath);
    const rangeRows = await this.table
      .query()
      .where(`filepath = '${escapedFilepath}' AND chunk_index BETWEEN ${minIndex} AND ${maxIndex}`)
      .toArray();

    // Lightweight count query for total chunks in the file (select only chunk_index)
    const allChunkIndexRows = await this.table
      .query()
      .where(`filepath = '${escapedFilepath}'`)
      .select(["chunk_index"])
      .toArray();
    const totalChunks = allChunkIndexRows.length;

    const normalized = rangeRows
      .map((row) => row as ChunkRow)
      .sort((a, b) => toNumberField(a, "chunk_index") - toNumberField(b, "chunk_index"));

    const blocks: string[] = [];
    for (const row of normalized) {
      const chunkId = expectStringField(row, "chunk_id");
      const content = expectStringField(row, "content");
      const chunkIndex = toNumberField(row, "chunk_index");
      const positionLabel = `Chunk ${chunkIndex + 1} of ${totalChunks}`;
      const contextOffset = chunkIndex - targetIndex;
      const role =
        contextOffset === 0
          ? "Target"
          : `Context: ${contextOffset > 0 ? `+${contextOffset}` : contextOffset}`;

      blocks.push(`--- Chunk: ${chunkId} (${positionLabel}) (${role}) ---\n${content}`);
    }

    return {
      text: blocks.join("\n\n")
    };
  }

  private async runFtsQuery(
    query: FullTextQuery,
    whereClause: string | null,
    limit: number
  ): Promise<ChunkRow[]> {
    let builder = this.table.search(query, "fts");
    if (whereClause) {
      builder = builder.where(whereClause);
    }

    const rows = await builder.limit(limit).toArray();
    return rows.map((row) => row as ChunkRow);
  }

  private async runVectorQuery(
    query: string,
    whereClause: string | null,
    limit: number
  ): Promise<ChunkRow[]> {
    if (!this.queryEmbeddingProvider) {
      return [];
    }

    try {
      const vectors = await this.queryEmbeddingProvider.embed([query]);
      const vector = vectors[0];
      if (!vector || vector.length === 0) {
        return [];
      }

      let builder = this.table.search(vector as number[], "vector", "vector") as unknown as {
        where: (predicate: string) => unknown;
        limit: (count: number) => { toArray: () => Promise<unknown[]> };
      };

      if (whereClause) {
        builder = builder.where(whereClause) as typeof builder;
      }

      const rows = await builder.limit(limit).toArray();
      return rows.map((row) => row as ChunkRow);
    } catch (error) {
      this.warnVectorFailure(error);
      return [];
    }
  }

  private async buildHint(
    query: string,
    filters: Record<string, string>
  ): Promise<SearchHint> {
    const fallbackRows = await this.table
      .search(new MultiMatchQuery(query, ["heading", "content_text"], { boosts: [3, 1] }), "fts")
      .limit(100)
      .toArray();

    if (fallbackRows.length === 0) {
      return {
        message: "0 results found. No matches were found for this query in the indexed corpus.",
        suggested_filters: {}
      };
    }

    const suggestions: Record<string, string[]> = {};
    for (const [key, activeValue] of Object.entries(filters)) {
      const values = new Set<string>();
      for (const row of fallbackRows) {
        const metadata = extractMetadata(row as ChunkRow, this.metadataKeys);
        const candidate = metadata[key];
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
      suggested_filters: suggestions
    };
  }

  private warnVectorFailure(error: unknown): void {
    if (this.hasWarnedVectorFailure) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    this.onWarning(`vector search degraded to lexical-only: ${detail}`);
    this.hasWarnedVectorFailure = true;
  }
}

function blendRows(
  matchRows: ChunkRow[],
  phraseRows: ChunkRow[],
  vectorRows: ChunkRow[],
  proximityWeight: number,
  vectorWeight: number,
  matchWeight: number = 1
): Array<{ row: ChunkRow; score: number }> {
  const byChunkId = new Map<
    string,
    {
      row: ChunkRow;
      matchRank?: number;
      phraseRank?: number;
      vectorRank?: number;
    }
  >();

  const captureRanks = (
    rows: ChunkRow[],
    key: "matchRank" | "phraseRank" | "vectorRank"
  ): void => {
    for (const [index, row] of rows.entries()) {
      const chunkId = expectStringField(row, "chunk_id");
      const rank = index + 1;
      const entry = byChunkId.get(chunkId) ?? { row };
      entry.row = row;

      const existing = entry[key];
      if (existing === undefined || rank < existing) {
        entry[key] = rank;
      }
      byChunkId.set(chunkId, entry);
    }
  };

  captureRanks(matchRows, "matchRank");
  captureRanks(phraseRows, "phraseRank");
  captureRanks(vectorRows, "vectorRank");

  return [...byChunkId.values()]
    .map((entry) => {
      const score =
        rrf(entry.matchRank, matchWeight) +
        rrf(entry.phraseRank, proximityWeight) +
        rrf(entry.vectorRank, vectorWeight);

      return {
        row: entry.row,
        score: Number(score.toFixed(6))
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return expectStringField(a.row, "chunk_id").localeCompare(expectStringField(b.row, "chunk_id"));
    });
}

function deduplicateRows(
  rows: Array<{ row: ChunkRow; score: number }>,
  collapseKeys: string[]
): Array<{ row: ChunkRow; score: number }> {
  if (collapseKeys.length === 0) return rows;

  const seen = new Set<string>();
  return rows.filter((entry) => {
    const key = dedupKey(
      expectStringField(entry.row, "filepath"),
      expectStringField(entry.row, "heading"),
      expectStringField(entry.row, "chunk_id"),
      (k) => expectStringField(entry.row, k),
      collapseKeys
    );
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildWhereClause(filters: Record<string, string>, taxonomyKeys?: string[]): string | null {
  const clauses: string[] = [];

  const language = filters.language;
  const scope = filters.scope;

  // Only apply auto-include if scope and language are both indexed taxonomy keys
  const hasScope = !taxonomyKeys || taxonomyKeys.includes("scope");
  const hasLanguage = !taxonomyKeys || taxonomyKeys.includes("language");

  if (hasScope && hasLanguage && language && !scope) {
    const escapedLanguage = escapeSqlString(language);
    const scopeColumn = quoteIdentifier("scope");
    const languageColumn = quoteIdentifier("language");
    clauses.push(
      `((${scopeColumn} = 'sdk-specific' AND ${languageColumn} = '${escapedLanguage}') OR ${scopeColumn} = 'global-guide' OR (${scopeColumn} <> 'sdk-specific' AND ${scopeColumn} <> 'global-guide' AND (${languageColumn} = '' OR ${languageColumn} = '${escapedLanguage}')))`
    );
  } else {
    if (language) {
      clauses.push(`${quoteIdentifier("language")} = '${escapeSqlString(language)}'`);
    }
    if (scope) {
      clauses.push(`${quoteIdentifier("scope")} = '${escapeSqlString(scope)}'`);
    }
  }

  for (const [key, value] of Object.entries(filters)) {
    if (key === "language" || key === "scope") {
      continue;
    }

    clauses.push(`${quoteIdentifier(key)} = '${escapeSqlString(value)}'`);
  }

  return clauses.length > 0 ? clauses.join(" AND ") : null;
}

function toSearchHit(
  row: ChunkRow,
  score: number,
  query: string,
  metadataKeys: string[]
): SearchHit {
  const contentText = expectStringField(row, "content_text");

  return {
    chunk_id: expectStringField(row, "chunk_id"),
    heading: expectStringField(row, "heading"),
    breadcrumb: expectStringField(row, "breadcrumb"),
    snippet: makeSnippet(contentText, query),
    filepath: expectStringField(row, "filepath"),
    metadata: extractMetadata(row, metadataKeys),
    score
  };
}

function extractMetadata(
  row: ChunkRow,
  metadataKeys: string[]
): Record<string, string> {
  const metadataJson = row.metadata_json;
  if (typeof metadataJson === "string" && metadataJson.trim()) {
    try {
      const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
      const metadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value) {
          metadata[key] = value;
        }
      }
      return metadata;
    } catch {
      // Fall through to column extraction.
    }
  }

  const metadata: Record<string, string> = {};
  for (const key of metadataKeys) {
    const value = row[key];
    if (typeof value === "string" && value) {
      metadata[key] = value;
    }
  }

  return metadata;
}

function serializeChunkRow(
  chunk: Chunk,
  metadataKeys: string[],
  vectorsByChunkId?: Map<string, number[]>,
  fileFingerprints?: Record<string, string>
): ChunkRow {
  const record: ChunkRow = {
    chunk_id: chunk.chunk_id,
    filepath: chunk.filepath,
    heading: chunk.heading,
    heading_level: chunk.heading_level,
    content: chunk.content,
    content_text: chunk.content_text,
    breadcrumb: chunk.breadcrumb,
    chunk_index: chunk.chunk_index,
    metadata_json: JSON.stringify(chunk.metadata)
  };

  for (const key of metadataKeys) {
    record[key] = chunk.metadata[key] ?? "";
  }

  if (fileFingerprints) {
    record.file_fingerprint = fileFingerprints[chunk.filepath] ?? "";
  }

  const vector = vectorsByChunkId?.get(chunk.chunk_id);
  if (vector) {
    record.vector = vector;
  }

  return record;
}

function collectMetadataKeys(chunks: Chunk[]): string[] {
  const keys = new Set<string>();
  for (const chunk of chunks) {
    for (const key of Object.keys(chunk.metadata)) {
      keys.add(key);
    }
  }

  return [...keys].sort((a, b) => a.localeCompare(b));
}

async function safeCreateScalarIndex(table: Table, column: string): Promise<void> {
  try {
    await table.createIndex(column, {
      config: Index.btree(),
      replace: true
    });
  } catch {
    // Non-fatal optimization path.
  }
}

function escapeSqlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replaceAll("\0", "")
    .replace(/'/g, "''");
}

function rrf(rank: number | undefined, weight: number): number {
  if (rank === undefined || weight <= 0) {
    return 0;
  }

  return weight / (RRF_K + rank);
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function expectStringField(row: ChunkRow, field: keyof ChunkRow | string): string {
  const value = row[field];
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function toNumberField(row: ChunkRow, field: keyof ChunkRow | string): number {
  const value = row[field];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePhraseSlop(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.floor(value);
  return Math.max(0, Math.min(5, rounded));
}

export interface ChunkRow extends Record<string, unknown> {
  chunk_id: string;
  filepath: string;
  heading: string;
  heading_level: number;
  content: string;
  content_text: string;
  breadcrumb: string;
  chunk_index: number;
  metadata_json: string;
  file_fingerprint?: string;
  vector?: number[];
}
