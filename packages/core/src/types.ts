export interface Chunk {
  chunk_id: string;
  filepath: string;
  heading: string;
  heading_level: number;
  content: string;
  content_text: string;
  breadcrumb: string;
  chunk_index: number;
  metadata: Record<string, string>;
}

export interface ChunkingStrategy {
  chunk_by: "h1" | "h2" | "h3" | "file";
  max_chunk_size?: number;
  min_chunk_size?: number;
}

export interface ManifestOverride {
  pattern: string;
  strategy?: ChunkingStrategy;
  metadata?: Record<string, string>;
}

export interface Manifest {
  version: string;
  strategy?: ChunkingStrategy;
  metadata?: Record<string, string>;
  overrides?: ManifestOverride[];
}

export interface RrfWeights {
  vector?: number;
  match?: number;
  phrase?: number;
}

export interface SearchRequest {
  query: string;
  limit: number;
  cursor?: string;
  filters: Record<string, string>;
  /** Available taxonomy keys from metadata, used for conditional auto-include */
  taxonomy_keys?: string[];
  /** Optional RRF weight overrides for this request */
  rrf_weights?: RrfWeights;
}

export interface SearchHit {
  chunk_id: string;
  heading: string;
  breadcrumb: string;
  snippet: string;
  filepath: string;
  metadata: Record<string, string>;
  score: number;
}

export interface SearchHint {
  message: string;
  suggested_filters: Record<string, string[]>;
}

export interface SearchResult {
  hits: SearchHit[];
  next_cursor: string | null;
  hint: SearchHint | null;
}

export interface SearchEngine {
  search(request: SearchRequest): Promise<SearchResult>;
  getDoc(request: GetDocRequest): Promise<GetDocResult>;
}

export interface TaxonomyField {
  description?: string;
  values: string[];
}

export interface MetadataStats {
  total_chunks: number;
  total_files: number;
  indexed_at: string;
  source_commit?: string | null;
}

export interface EmbeddingMetadata {
  provider: string;
  model: string;
  dimensions: number;
}

export interface CorpusMetadata {
  metadata_version: string;
  corpus_description: string;
  taxonomy: Record<string, TaxonomyField>;
  stats: MetadataStats;
  embedding: EmbeddingMetadata | null;
}

export interface GetDocRequest {
  chunk_id: string;
  context?: number;
}

export interface GetDocResult {
  text: string;
}

export interface BuildChunksInput {
  filepath: string;
  markdown: string;
  strategy: ChunkingStrategy;
  metadata?: Record<string, string>;
}

export interface ResolvedFileConfig {
  strategy: ChunkingStrategy;
  metadata: Record<string, string>;
}

export interface EmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
  configFingerprint: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly configFingerprint: string;
  readonly batchSize?: number;
  /** USD cost per 1 million input tokens, or 0 for free providers. */
  readonly costPerMillionTokens: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedProgressEvent {
  phase: "embedding";
  completed: number;
  total: number;
  cached: number;
}

export interface EmbedIncrementalOptions {
  batchSize?: number;
  onProgress?: (event: EmbedProgressEvent) => void;
}

export interface DocsIndexOptions {
  proximityWeight?: number;
  phraseSlop?: number;
}

export interface CursorPayload {
  offset: number;
  limit: number;
}
