import type {
  Chunk,
  EntrypointBundleRef,
  FileEntry,
  GetDocRequest,
  GetDocResult,
  ListFilepathsRequest,
  SearchEngine,
  SearchHit,
  SearchRequest,
  SearchResult
} from "@speakeasy-api/docs-mcp-core";
import { createHash } from "node:crypto";

type RegistrySymbol = {
  id: string;
  uses?: string[];
};

export type LlmsGoQueryConfig = {
  chunks: Chunk[];
  registrySymbols: RegistrySymbol[];
};

export class LlmsGoSearchEngine implements SearchEngine {
  private readonly base: SearchEngine;
  private readonly byChunkId: Map<string, Chunk>;
  private readonly entrypointChunks: Chunk[];
  private readonly entrypointBundle: EntrypointBundleRef;
  private readonly registryBySymbol: Map<string, RegistrySymbol>;
  private readonly chunkIdBySymbol: Map<string, string>;
  private readonly chunkByHeading: Map<string, Chunk>;

  constructor(base: SearchEngine, config: LlmsGoQueryConfig) {
    this.base = base;
    this.byChunkId = new Map(config.chunks.map((chunk) => [chunk.chunk_id, chunk]));
    this.entrypointChunks = config.chunks
      .filter((chunk) => chunk.metadata.source === "llms-go" && chunk.metadata.entrypoint === "true")
      .sort((a, b) => a.chunk_index - b.chunk_index);
    this.registryBySymbol = buildRegistryIndex(config.registrySymbols);
    this.chunkIdBySymbol = buildChunkIdBySymbolMap(config.chunks);
    this.chunkByHeading = buildChunkByHeadingMap(config.chunks);
    this.entrypointBundle = this.materializeEntrypointBundle(config.registrySymbols);
  }

  // ---------------------------------------------------------------------------
  // search_docs — lean: methods only + dependency_count + entrypoint_bundle ref
  // ---------------------------------------------------------------------------

  async search(request: SearchRequest): Promise<SearchResult> {
    const methodRequest: SearchRequest = {
      ...request,
      limit: request.limit ?? 5,
      filters: {
        ...(request.filters ?? {}),
        source: "llms-go",
        kind: "method"
      }
    };

    const methodResult = await this.base.search(methodRequest);
    const methodHits = this.inflateMethodHits(methodResult.hits);
    const isFirstPage = !request.cursor;

    const result: SearchResult = {
      hits: methodHits,
      next_cursor: methodResult.next_cursor,
      hint: methodResult.hits.length > 0 ? null : methodResult.hint
    };

    if (isFirstPage) {
      result.entrypoint_bundle = this.entrypointBundle;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // get_doc — symbols-based retrieval with optional hydration
  // ---------------------------------------------------------------------------

  async getDoc(request: GetDocRequest): Promise<GetDocResult> {
    if (!request.symbols || request.symbols.length === 0) {
      return this.base.getDoc(request);
    }

    const results: SymbolResult[] = [];
    const warnings: string[] = [];
    const seenChunkIds = new Set<string>();

    for (const symbol of request.symbols) {
      const resolved = this.resolveSymbol(symbol);
      if (!resolved) {
        warnings.push(`Symbol not found: '${symbol}'`);
        continue;
      }

      for (const chunk of resolved) {
        if (seenChunkIds.has(chunk.chunk_id)) continue;
        seenChunkIds.add(chunk.chunk_id);
        const depCount = this.countTransitiveDeps(chunk);
        results.push({ symbol: chunk.heading, content: chunk.content, dependency_count: depCount });
      }
    }

    if (request.hydrate) {
      const hydratedChunks = this.hydrateSymbols(request.symbols, seenChunkIds);
      for (const item of hydratedChunks) {
        results.push(item);
      }
    }

    const text = formatGetDocResponse(results, warnings);
    return { text };
  }

  async listFilepaths(request: ListFilepathsRequest): Promise<FileEntry[]> {
    return this.base.listFilepaths(request);
  }

  // ---------------------------------------------------------------------------
  // Symbol resolution
  // ---------------------------------------------------------------------------

  private resolveSymbol(symbol: string): Chunk[] | null {
    if (symbol.startsWith("entrypoint:")) {
      return this.entrypointChunks.length > 0 ? [...this.entrypointChunks] : null;
    }

    const byHeading = this.chunkByHeading.get(symbol);
    if (byHeading) return [byHeading];

    const bySymbolId = this.findChunkBySymbolId(symbol);
    if (bySymbolId) return [bySymbolId];

    return null;
  }

  private findChunkBySymbolId(symbol: string): Chunk | null {
    for (const chunk of this.byChunkId.values()) {
      if (chunk.metadata.symbol_id === symbol) return chunk;
    }
    for (const chunk of this.byChunkId.values()) {
      const sid = chunk.metadata.symbol_id ?? "";
      if (sid.endsWith(`.${symbol}`)) return chunk;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Hydration for get_doc
  // ---------------------------------------------------------------------------

  private hydrateSymbols(symbols: string[], alreadyIncluded: Set<string>): SymbolResult[] {
    const roots = new Set<string>();
    const pendingOwners: Chunk[] = [];

    for (const symbol of symbols) {
      if (symbol.startsWith("entrypoint:")) continue;

      const resolved = this.resolveSymbol(symbol);
      if (!resolved) continue;

      for (const chunk of resolved) {
        const symbolId = chunk.metadata.symbol_id;
        if (!symbolId) continue;
        const entry = this.registryBySymbol.get(symbolId);
        if (entry?.uses) {
          for (const use of entry.uses) roots.add(use);
        }

        if (chunk.metadata.kind === "method" && chunk.metadata.owner) {
          const ownerChunk = this.findOwnerTypeChunk(chunk.metadata.owner);
          if (ownerChunk && !alreadyIncluded.has(ownerChunk.chunk_id)) {
            pendingOwners.push(ownerChunk);
            roots.delete(ownerChunk.metadata.symbol_id ?? "");
          }
        }
      }
    }

    const allDeps = this.collectTransitiveClosure(roots, 8);
    const results: SymbolResult[] = [];

    for (const ownerChunk of pendingOwners) {
      if (alreadyIncluded.has(ownerChunk.chunk_id)) continue;
      alreadyIncluded.add(ownerChunk.chunk_id);
      const depCount = this.countTransitiveDeps(ownerChunk);
      results.push({
        symbol: ownerChunk.heading,
        content: ownerChunk.content,
        dependency_count: depCount,
        note: "owner type"
      });
    }

    for (const depSymbolId of allDeps) {
      const chunkId = this.chunkIdBySymbol.get(depSymbolId);
      if (!chunkId || alreadyIncluded.has(chunkId)) continue;
      alreadyIncluded.add(chunkId);
      const chunk = this.byChunkId.get(chunkId);
      if (!chunk) continue;
      const depCount = this.countTransitiveDeps(chunk);
      results.push({
        symbol: chunk.heading,
        content: chunk.content,
        dependency_count: depCount,
        note: "hydrated dependency"
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Helpers (reused by both search and getDoc)
  // ---------------------------------------------------------------------------

  private inflateMethodHits(hits: SearchHit[]): SearchHit[] {
    return hits.map((hit) => {
      const chunk = this.byChunkId.get(hit.chunk_id);
      if (!chunk) return hit;
      const depCount = this.countTransitiveDeps(chunk);
      return { ...toFullContentHit(chunk, hit.score), dependency_count: depCount };
    });
  }

  private countTransitiveDeps(chunk: Chunk): number {
    const symbolId = chunk.metadata.symbol_id;
    if (!symbolId) return 0;
    const entry = this.registryBySymbol.get(symbolId);
    if (!entry?.uses || entry.uses.length === 0) return 0;
    const roots = new Set(entry.uses);
    return this.collectTransitiveClosure(roots, 8).size;
  }

  private findOwnerTypeChunk(ownerName: string): Chunk | undefined {
    for (const chunk of this.byChunkId.values()) {
      if (
        chunk.metadata.source === "llms-go" &&
        chunk.metadata.kind === "type" &&
        chunk.heading === ownerName
      ) {
        return chunk;
      }
    }
    return undefined;
  }

  private collectTransitiveClosure(roots: Set<string>, maxDepth: number): Set<string> {
    const visited = new Set<string>();
    let frontier = [...roots];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const symbolId of frontier) {
        if (visited.has(symbolId)) continue;
        visited.add(symbolId);

        const entry = this.registryBySymbol.get(symbolId);
        if (!entry?.uses) continue;
        for (const use of entry.uses) {
          if (!visited.has(use)) {
            nextFrontier.push(use);
          }
        }
      }
      frontier = nextFrontier;
    }

    return visited;
  }

  private materializeEntrypointBundle(registrySymbols: RegistrySymbol[]): EntrypointBundleRef {
    const entrypointEntry = registrySymbols.find((s) => s.id.startsWith("entrypoint:"));
    const id = entrypointEntry?.id ?? "entrypoint:SDK";
    const contentHash = createHash("sha256")
      .update(this.entrypointChunks.map((c) => c.content).join("\n"))
      .digest("hex")
      .slice(0, 8);

    return {
      id,
      version: contentHash,
      hint: `Call get_doc with symbols=['${id}'] to retrieve the SDK construction surface. Fetch once per session.`
    };
  }
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

type SymbolResult = {
  symbol: string;
  content: string;
  dependency_count: number;
  note?: string;
};

function formatGetDocResponse(results: SymbolResult[], warnings: string[]): string {
  const sections: string[] = [];

  for (const r of results) {
    const header = r.note ? `### ${r.symbol} (${r.note})` : `### ${r.symbol}`;
    sections.push(`${header}\n\n${r.content}\n\n_Dependencies: ${r.dependency_count}_`);
  }

  if (warnings.length > 0) {
    sections.push(`---\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Index builders
// ---------------------------------------------------------------------------

function buildRegistryIndex(symbols: RegistrySymbol[]): Map<string, RegistrySymbol> {
  const index = new Map<string, RegistrySymbol>();
  for (const symbol of symbols) {
    index.set(symbol.id, symbol);

    if (symbol.id.startsWith("method:")) {
      const shortKey = toShortMethodSymbol(symbol.id);
      if (shortKey) {
        index.set(shortKey, symbol);
      }
    }
  }
  return index;
}

function buildChunkIdBySymbolMap(chunks: Chunk[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of chunks) {
    const symbol = chunk.metadata.symbol_id;
    if (!symbol) continue;
    out.set(symbol, chunk.chunk_id);
  }
  return out;
}

function buildChunkByHeadingMap(chunks: Chunk[]): Map<string, Chunk> {
  const out = new Map<string, Chunk>();
  for (const chunk of chunks) {
    if (chunk.metadata.source !== "llms-go") continue;
    const heading = chunk.heading;
    if (!heading) continue;
    const key = chunk.metadata.kind === "method" && chunk.metadata.owner
      ? `${chunk.metadata.owner}.${chunk.metadata.method ?? heading}`
      : heading;
    if (!out.has(key)) {
      out.set(key, chunk);
    }
  }
  return out;
}

function toShortMethodSymbol(id: string): string | null {
  const match = id.match(/^method:[^:]+\.\(\*([^)]+)\)\.([A-Za-z0-9_]+)$/);
  if (!match) return null;
  const owner = match[1];
  const method = match[2];
  if (!owner || !method) return null;
  return `method:${owner}.${method}`;
}

function toFullContentHit(chunk: Chunk, score: number): SearchHit {
  return {
    chunk_id: chunk.chunk_id,
    heading: chunk.heading,
    breadcrumb: chunk.breadcrumb,
    snippet: "",
    content: chunk.content,
    filepath: chunk.filepath,
    metadata: chunk.metadata,
    score
  };
}
