import { describe, expect, it } from "vitest";
import type { Chunk, GetDocRequest, SearchEngine, SearchRequest, SearchResult } from "@speakeasy-api/docs-mcp-core";
import { LlmsGoSearchEngine } from "../src/llms-go-search.js";

const chunks: Chunk[] = [
  {
    chunk_id: "llms/ciscoplatform.go#entrypoint-sdk",
    filepath: "llms/ciscoplatform.go",
    heading: "SDK",
    heading_level: 2,
    content: "## SDK\n\n```go\ntype SDK struct {\n\tTenants *Tenants\n}\n```",
    content_text: "type SDK struct { Tenants *Tenants }",
    breadcrumb: "llms/ciscoplatform.go > SDK",
    chunk_index: 0,
    metadata: { source: "llms-go", kind: "entrypoint", entrypoint: "true" }
  },
  {
    chunk_id: "llms/ciscoplatform.go#entrypoint-new",
    filepath: "llms/ciscoplatform.go",
    heading: "New",
    heading_level: 2,
    content: "## New\n\n```go\nfunc New(serverURL string, opts ...SDKOption) *SDK\n```",
    content_text: "func New(serverURL string, opts ...SDKOption) *SDK",
    breadcrumb: "llms/ciscoplatform.go > New",
    chunk_index: 1,
    metadata: { source: "llms-go", kind: "entrypoint", entrypoint: "true" }
  },
  {
    chunk_id: "llms/ciscoplatform.go#type-tenants",
    filepath: "llms/ciscoplatform.go",
    heading: "Tenants",
    heading_level: 2,
    content: "## Tenants\n\n```go\ntype Tenants struct {}\n```",
    content_text: "type Tenants struct {}",
    breadcrumb: "llms/ciscoplatform.go > Tenants",
    chunk_index: 2,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: "type:pkg.Tenants",
      sdk_import: "pkg",
      sdk_symbol: "Tenants",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/ciscoplatform.go#method-tenants-gettenant",
    filepath: "llms/ciscoplatform.go",
    heading: "Tenants.GetTenant",
    heading_level: 2,
    content: "## Tenants.GetTenant\n\nGet tenant by ID\n\n```go\nfunc (s *Tenants) GetTenant(...)\n```",
    content_text: "func (s *Tenants) GetTenant(ctx context.Context, id string) (*operations.GetTenantResponse, error)",
    breadcrumb: "llms/ciscoplatform.go > Tenants > GetTenant",
    chunk_index: 3,
    metadata: {
      source: "llms-go",
      kind: "method",
      owner: "Tenants",
      method: "GetTenant",
      symbol_id: "method:Tenants.GetTenant",
      sdk_symbol: "GetTenant",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/ciscoplatform.go#method-tenants-createtenant",
    filepath: "llms/ciscoplatform.go",
    heading: "Tenants.CreateTenant",
    heading_level: 2,
    content: "## Tenants.CreateTenant\n\nCreate a tenant\n\n```go\nfunc (s *Tenants) CreateTenant(...)\n```",
    content_text: "func (s *Tenants) CreateTenant(ctx context.Context, req CreateTenantRequest) (*operations.CreateTenantResponse, error)",
    breadcrumb: "llms/ciscoplatform.go > Tenants > CreateTenant",
    chunk_index: 4,
    metadata: {
      source: "llms-go",
      kind: "method",
      owner: "Tenants",
      method: "CreateTenant",
      symbol_id: "method:Tenants.CreateTenant",
      sdk_symbol: "CreateTenant",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/models/operations/operations.go#type-gettenantresponse",
    filepath: "llms/models/operations/operations.go",
    heading: "GetTenantResponse",
    heading_level: 2,
    content: "## GetTenantResponse\n\n```go\ntype GetTenantResponse struct{}\n```",
    content_text: "type GetTenantResponse struct{}",
    breadcrumb: "llms/models/operations/operations.go > GetTenantResponse",
    chunk_index: 5,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: "type:pkg/models/operations.GetTenantResponse",
      sdk_import: "pkg/models/operations",
      sdk_symbol: "GetTenantResponse",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/models/operations/operations.go#type-createtenantrequest",
    filepath: "llms/models/operations/operations.go",
    heading: "CreateTenantRequest",
    heading_level: 2,
    content: "## CreateTenantRequest\n\n```go\ntype CreateTenantRequest struct{ Name TenantName }\n```",
    content_text: "type CreateTenantRequest struct{ Name TenantName }",
    breadcrumb: "llms/models/operations/operations.go > CreateTenantRequest",
    chunk_index: 6,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: "type:pkg/models/operations.CreateTenantRequest",
      sdk_import: "pkg/models/operations",
      sdk_symbol: "CreateTenantRequest",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/models/operations/operations.go#type-tenantname",
    filepath: "llms/models/operations/operations.go",
    heading: "TenantName",
    heading_level: 2,
    content: "## TenantName\n\n```go\ntype TenantName string\n```",
    content_text: "type TenantName string",
    breadcrumb: "llms/models/operations/operations.go > TenantName",
    chunk_index: 7,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: "type:pkg/models/operations.TenantName",
      sdk_import: "pkg/models/operations",
      sdk_symbol: "TenantName",
      entrypoint: "false"
    }
  },
  {
    chunk_id: "llms/models/operations/operations.go#type-createtenantresponse",
    filepath: "llms/models/operations/operations.go",
    heading: "CreateTenantResponse",
    heading_level: 2,
    content: "## CreateTenantResponse\n\n```go\ntype CreateTenantResponse struct{}\n```",
    content_text: "type CreateTenantResponse struct{}",
    breadcrumb: "llms/models/operations/operations.go > CreateTenantResponse",
    chunk_index: 8,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: "type:pkg/models/operations.CreateTenantResponse",
      sdk_import: "pkg/models/operations",
      sdk_symbol: "CreateTenantResponse",
      entrypoint: "false"
    }
  }
];

const registrySymbols = [
  {
    id: "entrypoint:pkg.SDK",
    uses: [
      "type:pkg.Tenants"
    ]
  },
  {
    id: "method:pkg.(*Tenants).GetTenant",
    uses: [
      "type:pkg/models/operations.GetTenantResponse"
    ]
  },
  {
    id: "method:pkg.(*Tenants).CreateTenant",
    uses: [
      "type:pkg/models/operations.CreateTenantRequest",
      "type:pkg/models/operations.CreateTenantResponse"
    ]
  },
  {
    id: "type:pkg.Tenants",
    uses: []
  },
  {
    id: "type:pkg/models/operations.GetTenantResponse",
    uses: []
  },
  {
    id: "type:pkg/models/operations.CreateTenantRequest",
    uses: [
      "type:pkg/models/operations.TenantName"
    ]
  },
  {
    id: "type:pkg/models/operations.CreateTenantResponse",
    uses: []
  },
  {
    id: "type:pkg/models/operations.TenantName",
    uses: []
  }
];

function createEngine(returnChunkIds: string[]): LlmsGoSearchEngine {
  const base = createBaseEngine(returnChunkIds);
  return new LlmsGoSearchEngine(base, { chunks, registrySymbols });
}

// ---------------------------------------------------------------------------
// search_docs — V3 lean results
// ---------------------------------------------------------------------------

describe("LlmsGoSearchEngine — search_docs (V3 lean)", () => {
  it("returns only method hits — no entrypoints, no types, no hydrated deps", async () => {
    const engine = createEngine(["llms/ciscoplatform.go#method-tenants-gettenant"]);
    const result = await engine.search({ query: "get tenant", limit: 5, filters: {} });
    const ids = result.hits.map((h) => h.chunk_id);

    expect(ids).toContain("llms/ciscoplatform.go#method-tenants-gettenant");
    expect(ids).not.toContain("llms/ciscoplatform.go#entrypoint-sdk");
    expect(ids).not.toContain("llms/ciscoplatform.go#entrypoint-new");
    expect(ids).not.toContain("llms/ciscoplatform.go#type-tenants");
    expect(ids).not.toContain("llms/models/operations/operations.go#type-gettenantresponse");
    expect(ids.length).toBe(1);
  });

  it("includes dependency_count on each method hit", async () => {
    const engine = createEngine(["llms/ciscoplatform.go#method-tenants-createtenant"]);
    const result = await engine.search({ query: "create tenant", limit: 5, filters: {} });

    const hit = result.hits.find((h) => h.chunk_id === "llms/ciscoplatform.go#method-tenants-createtenant");
    expect(hit).toBeDefined();
    expect(hit!.dependency_count).toBeGreaterThan(0);
  });

  it("includes entrypoint_bundle metadata on first page", async () => {
    const engine = createEngine(["llms/ciscoplatform.go#method-tenants-gettenant"]);
    const result = await engine.search({ query: "get tenant", limit: 5, filters: {} });

    expect(result.entrypoint_bundle).toBeDefined();
    expect(result.entrypoint_bundle!.id).toBe("entrypoint:pkg.SDK");
    expect(result.entrypoint_bundle!.version).toMatch(/^[a-f0-9]+$/);
    expect(result.entrypoint_bundle!.hint).toContain("get_doc");
  });

  it("omits entrypoint_bundle on paginated requests", async () => {
    const engine = createEngine(["llms/ciscoplatform.go#method-tenants-gettenant"]);
    const result = await engine.search({
      query: "get tenant",
      limit: 5,
      cursor: "page-2",
      filters: {}
    });

    expect(result.entrypoint_bundle).toBeUndefined();
  });

  it("returns empty hits when no methods match (no entrypoints injected)", async () => {
    const engine = createEngine([]);
    const result = await engine.search({ query: "something irrelevant", limit: 5, filters: {} });

    expect(result.hits.length).toBe(0);
    expect(result.entrypoint_bundle).toBeDefined();
  });

  it("includes full content on method hits", async () => {
    const engine = createEngine(["llms/ciscoplatform.go#method-tenants-gettenant"]);
    const result = await engine.search({ query: "get tenant", limit: 5, filters: {} });

    const hit = result.hits[0]!;
    expect(hit.content).toBeDefined();
    expect(hit.content!).toContain("GetTenant");
    expect(hit.content!).toContain("```go");
    expect(hit.snippet).toBe("");
  });
});

// ---------------------------------------------------------------------------
// get_doc — symbols resolution
// ---------------------------------------------------------------------------

describe("LlmsGoSearchEngine — get_doc with symbols", () => {
  it("resolves entrypoint bundle symbol", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ symbols: ["entrypoint:pkg.SDK"] });

    expect(result.text).toContain("SDK");
    expect(result.text).toContain("New");
  });

  it("resolves a method by Owner.Method heading", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ symbols: ["Tenants.GetTenant"] });

    expect(result.text).toContain("GetTenant");
  });

  it("resolves a type by heading", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ symbols: ["CreateTenantRequest"] });

    expect(result.text).toContain("CreateTenantRequest");
  });

  it("returns warnings for unresolvable symbols", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ symbols: ["NonExistent.Method"] });

    expect(result.text).toContain("Symbol not found");
    expect(result.text).toContain("NonExistent.Method");
  });

  it("handles multiple symbols in one call", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.GetTenant", "CreateTenantRequest"]
    });

    expect(result.text).toContain("GetTenant");
    expect(result.text).toContain("CreateTenantRequest");
  });

  it("falls back to base.getDoc when chunk_id is provided", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ chunk_id: "some-chunk-id" });
    expect(result.text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// get_doc — hydration
// ---------------------------------------------------------------------------

describe("LlmsGoSearchEngine — get_doc with hydrate", () => {
  it("includes transitive dependencies when hydrate=true", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.CreateTenant"],
      hydrate: true
    });

    expect(result.text).toContain("CreateTenant");
    expect(result.text).toContain("Tenants");
    expect(result.text).toContain("CreateTenantRequest");
    expect(result.text).toContain("CreateTenantResponse");
    expect(result.text).toContain("TenantName");
  });

  it("includes owner type when hydrating a method", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.GetTenant"],
      hydrate: true
    });

    expect(result.text).toContain("owner type");
    expect(result.text).toContain("type Tenants struct");
  });

  it("does not include transitive deps when hydrate=false", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.CreateTenant"],
      hydrate: false
    });

    expect(result.text).toContain("CreateTenant");
    expect(result.text).not.toContain("CreateTenantRequest");
    expect(result.text).not.toContain("TenantName");
  });

  it("deduplicates chunks across multiple hydrated symbols", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.GetTenant", "Tenants.CreateTenant"],
      hydrate: true
    });

    const ownerMatches = result.text.match(/type Tenants struct/g) ?? [];
    expect(ownerMatches.length).toBe(1);
  });

  it("includes dependency_count in formatted output", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({
      symbols: ["Tenants.CreateTenant"],
      hydrate: true
    });

    expect(result.text).toContain("Dependencies:");
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe("LlmsGoSearchEngine — backward compatibility", () => {
  it("get_doc with chunk_id delegates to base engine", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ chunk_id: "any-id", context: 2 });
    expect(result.text).toBe("ok");
  });

  it("get_doc with empty symbols falls back to base", async () => {
    const engine = createEngine([]);
    const result = await engine.getDoc({ chunk_id: "any-id" });
    expect(result.text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createBaseEngine(returnChunkIds: string[]): SearchEngine {
  const methodChunks = chunks.filter((c) =>
    c.metadata.kind === "method" && returnChunkIds.includes(c.chunk_id)
  );
  return {
    async search(request: SearchRequest): Promise<SearchResult> {
      expect(request.filters.source).toBe("llms-go");
      expect(request.filters.kind).toBe("method");
      return {
        hits: methodChunks.map((c) => ({
          chunk_id: c.chunk_id,
          heading: c.heading,
          breadcrumb: c.breadcrumb,
          snippet: c.content_text,
          filepath: c.filepath,
          metadata: c.metadata,
          score: 12.5
        })),
        next_cursor: null,
        hint: null
      };
    },
    async getDoc(_request: GetDocRequest): Promise<{ text: string }> {
      return { text: "ok" };
    }
  };
}
