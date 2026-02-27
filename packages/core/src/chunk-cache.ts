import { connect } from "@lancedb/lancedb";
import { sha256hex } from "./embedding.js";
import type { Chunk, ChunkingStrategy } from "./types.js";
import type { ChunkRow } from "./lancedb.js";

const DEFAULT_TABLE_NAME = "chunks";

/**
 * Compute a fingerprint for a file's chunking inputs.
 * Changes when the markdown, strategy, or metadata change.
 */
export function computeChunkFingerprint(
  markdown: string,
  strategy: ChunkingStrategy,
  metadata: Record<string, string>,
): string {
  return sha256hex([JSON.stringify(strategy), JSON.stringify(metadata), markdown].join("\0"));
}

export interface PreviousIndexReader {
  fingerprints: Map<string, string>; // filepath → fingerprint
  getChunks(filepath: string): Promise<Chunk[]>;
  close(): void;
}

/**
 * Open the previous `.lancedb/` index and extract per-file fingerprints.
 * Returns null if the index doesn't exist or lacks the `file_fingerprint` column.
 */
export async function loadChunksFromPreviousIndex(
  dbPath: string,
  tableName?: string,
): Promise<PreviousIndexReader | null> {
  const table = tableName ?? DEFAULT_TABLE_NAME;

  let db;
  try {
    db = await connect(dbPath);
  } catch {
    return null;
  }

  try {
    const tableNames = await db.tableNames();
    if (!tableNames.includes(table)) {
      db.close();
      return null;
    }

    const tbl = await db.openTable(table);

    // Probe for file_fingerprint column by fetching a single row
    const probeRows = await tbl.query().select(["filepath", "file_fingerprint"]).limit(1).toArray();

    if (probeRows.length === 0) {
      // Empty table — nothing to cache from
      tbl.close();
      db.close();
      return null;
    }

    const probeRow = probeRows[0]!;
    if (!("file_fingerprint" in probeRow) || typeof probeRow.file_fingerprint !== "string") {
      // Old-format index without fingerprints
      tbl.close();
      db.close();
      return null;
    }

    // Load all fingerprints (lightweight: only two string columns)
    const fpRows = await tbl.query().select(["filepath", "file_fingerprint"]).toArray();

    const fingerprints = new Map<string, string>();
    for (const row of fpRows) {
      const filepath = row.filepath as string;
      const fp = row.file_fingerprint as string;
      if (fp) {
        fingerprints.set(filepath, fp);
      }
    }

    return {
      fingerprints,
      async getChunks(filepath: string): Promise<Chunk[]> {
        const escaped = filepath.replace(/'/g, "''");
        const rows = await tbl.query().where(`filepath = '${escaped}'`).toArray();

        return rows
          .map((row) => row as ChunkRow)
          .sort((a, b) => toNumber(a.chunk_index) - toNumber(b.chunk_index))
          .map((row) => rowToChunk(row));
      },
      close() {
        tbl.close();
        db.close();
      },
    };
  } catch {
    db.close();
    return null;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowToChunk(row: ChunkRow): Chunk {
  let metadata: Record<string, string> = {};
  if (typeof row.metadata_json === "string" && row.metadata_json.trim()) {
    try {
      const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          metadata[key] = value;
        }
      }
    } catch {
      metadata = {};
    }
  }

  return {
    chunk_id: String(row.chunk_id ?? ""),
    filepath: String(row.filepath ?? ""),
    heading: String(row.heading ?? ""),
    heading_level: toNumber(row.heading_level),
    content: String(row.content ?? ""),
    content_text: String(row.content_text ?? ""),
    breadcrumb: String(row.breadcrumb ?? ""),
    chunk_index: toNumber(row.chunk_index),
    metadata,
  };
}
