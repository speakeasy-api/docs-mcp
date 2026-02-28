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

export interface TaxonomyValueProperties {
  mcp_resource: boolean;
}

export interface ManifestTaxonomyFieldConfig {
  vector_collapse: boolean;
  properties?: Record<string, TaxonomyValueProperties> | undefined;
}

export interface Manifest {
  version: string;
  strategy?: ChunkingStrategy;
  metadata?: Record<string, string>;
  taxonomy?: Record<string, ManifestTaxonomyFieldConfig>;
  instructions?: string;
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

export interface ListFilepathsRequest {
  filters: Record<string, string>;
}

export interface FileEntry {
  filepath: string;
  firstChunkId: string;
}

export interface SearchEngine {
  search(request: SearchRequest): Promise<SearchResult>;
  getDoc(request: GetDocRequest): Promise<GetDocResult>;
  listFilepaths(request: ListFilepathsRequest): Promise<FileEntry[]>;
}

export interface TaxonomyField {
  description?: string;
  values: string[];
  /**
   * When true, this taxonomy dimension identifies content variants that are
   * near-identical in vector space (e.g. the same API operation documented in
   * multiple languages). Search results sharing the same content identity —
   * determined by normalizing this field's value out of the filepath — are
   * collapsed to the highest-scoring result. Has no effect when a filter for
   * this field is active, since the filter already restricts to a single value.
   */
  vector_collapse?: boolean;
  /** Per-value properties (e.g. `mcp_resource`) for this taxonomy dimension. */
  properties?: Record<string, TaxonomyValueProperties>;
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

export interface ToolDescriptions {
  search_docs?: string;
  get_doc?: string;
}

export interface CorpusMetadata {
  metadata_version: string;
  corpus_description: string;
  taxonomy: Record<string, TaxonomyField>;
  stats: MetadataStats;
  embedding: EmbeddingMetadata | null;
  tool_descriptions?: ToolDescriptions;
  instructions?: string;
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
  readonly batchApiThreshold?: number;
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
  batchApiThreshold?: number;
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
