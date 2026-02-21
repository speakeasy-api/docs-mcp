import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChunks } from "../src/chunking.js";
import { buildLanceDbIndex, LanceDbSearchEngine } from "../src/lancedb.js";
import { parseManifest, resolveFileConfig } from "../src/manifest.js";
import type { Chunk, Manifest } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/docs");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Loads the nearest manifest for a fixture file and resolves its config.
 * Mirrors the CLI's `loadNearestManifest` walk without pulling in the CLI.
 */
async function resolveFixtureFile(relPath: string) {
  const fullPath = path.join(FIXTURES_DIR, relPath);
  const markdown = await readFile(fullPath, "utf8");

  // Walk up from the file to FIXTURES_DIR looking for .mcp-manifest.json
  let manifestDir = path.dirname(fullPath);
  let manifest: Manifest | undefined;
  let manifestBaseDir = "";
  while (true) {
    const candidate = path.join(manifestDir, ".mcp-manifest.json");
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8"));
      manifest = parseManifest(raw);
      manifestBaseDir = path.relative(FIXTURES_DIR, manifestDir).split(path.sep).join("/");
      break;
    } catch {
      // not found, walk up
    }
    if (path.resolve(manifestDir) === path.resolve(FIXTURES_DIR)) break;
    manifestDir = path.dirname(manifestDir);
  }

  const config = resolveFileConfig({
    relativeFilePath: relPath,
    manifest,
    manifestBaseDir,
    markdown
  });

  return { markdown, config };
}

const ALL_FIXTURE_FILES = [
  "guides/authentication.md",
  "guides/rate-limiting.md",
  "guides/webhooks.md",
  "sdk/python/readme.md",
  "sdk/typescript/readme.md"
];

async function buildAllChunks(): Promise<Chunk[]> {
  const allChunks: Chunk[] = [];
  for (const relPath of ALL_FIXTURE_FILES) {
    const { markdown, config } = await resolveFixtureFile(relPath);
    const chunks = buildChunks({
      filepath: relPath,
      markdown,
      strategy: config.strategy,
      metadata: config.metadata
    });
    allChunks.push(...chunks);
  }
  return allChunks;
}

describe("integration: build → search → getDoc round-trip", () => {
  it("chunks fixture corpus, builds LanceDB index, and performs search + getDoc", async () => {
    const allChunks = await buildAllChunks();

    expect(allChunks.length).toBeGreaterThan(10);

    // Verify SDK files got sdk-specific scope from their per-directory manifest
    const tsChunks = allChunks.filter(
      (c) => c.filepath === "sdk/typescript/readme.md"
    );
    expect(tsChunks.length).toBeGreaterThan(0);
    expect(tsChunks[0]?.metadata.scope).toBe("sdk-specific");
    expect(tsChunks[0]?.metadata.language).toBe("typescript");

    const pyChunks = allChunks.filter(
      (c) => c.filepath === "sdk/python/readme.md"
    );
    expect(pyChunks.length).toBeGreaterThan(0);
    expect(pyChunks[0]?.metadata.scope).toBe("sdk-specific");
    expect(pyChunks[0]?.metadata.language).toBe("python");

    // Verify global guides got global-guide scope and no language
    const authChunks = allChunks.filter(
      (c) => c.filepath === "guides/authentication.md"
    );
    expect(authChunks.length).toBeGreaterThan(0);
    expect(authChunks[0]?.metadata.scope).toBe("global-guide");
    expect(authChunks[0]?.metadata.language).toBeUndefined();

    // 3. Build LanceDB index
    const dbDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-integration-"));
    tempDirs.push(dbDir);

    const metadataKeys = ["scope", "language"];
    const buildResult = await buildLanceDbIndex({
      dbPath: dbDir,
      chunks: allChunks,
      metadataKeys
    });

    expect(buildResult.tableName).toBe("chunks");
    expect(buildResult.metadataKeys).toEqual(metadataKeys);

    // 4. Open search engine
    const engine = await LanceDbSearchEngine.open({
      dbPath: dbDir,
      metadataKeys
    });

    // 5. Search: unfiltered query
    const result1 = await engine.search({
      query: "authentication",
      limit: 5,
      filters: {}
    });

    expect(result1.hits.length).toBeGreaterThan(0);
    expect(result1.hits[0]?.chunk_id).toBeTruthy();
    expect(result1.hits[0]?.score).toBeGreaterThan(0);
    expect(result1.hits[0]?.snippet.length).toBeGreaterThan(0);

    // 6. Search: language filter with auto-include
    const result2 = await engine.search({
      query: "authentication",
      limit: 10,
      filters: { language: "typescript" },
      taxonomy_keys: metadataKeys
    });

    expect(result2.hits.length).toBeGreaterThan(0);

    // Should include both sdk-specific (typescript) and global-guide results
    const hasGlobal = result2.hits.some((h) => h.metadata.scope === "global-guide");
    const hasSdk = result2.hits.some((h) => h.metadata.scope === "sdk-specific");
    expect(hasGlobal).toBe(true);
    expect(hasSdk).toBe(true);

    // 7. getDoc: retrieve a specific chunk with context
    const targetChunkId = result1.hits[0]!.chunk_id;
    const doc1 = await engine.getDoc({ chunk_id: targetChunkId });
    expect(doc1.text.length).toBeGreaterThan(0);

    const doc2 = await engine.getDoc({ chunk_id: targetChunkId, context: 1 });
    expect(doc2.text.length).toBeGreaterThanOrEqual(doc1.text.length);

    // 8. Pagination: verify cursor round-trip
    const page1 = await engine.search({
      query: "authentication",
      limit: 2,
      filters: {}
    });

    if (page1.next_cursor) {
      const page2 = await engine.search({
        query: "authentication",
        limit: 2,
        cursor: page1.next_cursor,
        filters: {}
      });
      expect(page2.hits.length).toBeGreaterThan(0);

      // Verify pagination advances (page 2 has at least one different result)
      const page1Ids = new Set(page1.hits.map((h) => h.chunk_id));
      const page2Ids = new Set(page2.hits.map((h) => h.chunk_id));
      const allIds = new Set([...page1Ids, ...page2Ids]);
      expect(allIds.size).toBeGreaterThan(page1Ids.size);
    }

    // 9. Zero-result search returns hint
    const result3 = await engine.search({
      query: "zzzznonexistent",
      limit: 5,
      filters: {}
    });
    expect(result3.hits.length).toBe(0);
    expect(result3.hint).not.toBeNull();
  });

  it("language filter excludes the other SDK", async () => {
    const allChunks = await buildAllChunks();

    const dbDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-lang-filter-"));
    tempDirs.push(dbDir);

    const metadataKeys = ["scope", "language"];
    await buildLanceDbIndex({ dbPath: dbDir, chunks: allChunks, metadataKeys });

    const engine = await LanceDbSearchEngine.open({ dbPath: dbDir, metadataKeys });

    // Search for "SDK" filtered to python — should return python SDK hits
    // plus global-guide hits (auto-include), but NOT typescript SDK hits.
    const result = await engine.search({
      query: "SDK installation",
      limit: 20,
      filters: { language: "python" },
      taxonomy_keys: metadataKeys
    });

    expect(result.hits.length).toBeGreaterThan(0);

    const pythonHits = result.hits.filter((h) => h.metadata.language === "python");
    const typescriptHits = result.hits.filter((h) => h.metadata.language === "typescript");

    expect(pythonHits.length).toBeGreaterThan(0);
    expect(typescriptHits.length).toBe(0);
  });

  it("phrase search ranks exact match higher than scattered terms", async () => {
    const dbDir = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-phrase-"));
    tempDirs.push(dbDir);

    const chunks: Chunk[] = [
      {
        chunk_id: "a.md#exact",
        filepath: "a.md",
        heading: "Retry Backoff",
        heading_level: 2,
        content: "Implement retry backoff to handle transient failures gracefully.",
        content_text: "Implement retry backoff to handle transient failures gracefully.",
        breadcrumb: "a.md > Retry Backoff",
        chunk_index: 0,
        metadata: {}
      },
      {
        chunk_id: "b.md#scattered",
        filepath: "b.md",
        heading: "Overview",
        heading_level: 2,
        content: "This section discusses retry strategies. Backoff is covered elsewhere in the docs.",
        content_text: "This section discusses retry strategies. Backoff is covered elsewhere in the docs.",
        breadcrumb: "b.md > Overview",
        chunk_index: 0,
        metadata: {}
      }
    ];

    await buildLanceDbIndex({ dbPath: dbDir, chunks });

    const engine = await LanceDbSearchEngine.open({
      dbPath: dbDir,
      metadataKeys: []
    });

    const result = await engine.search({
      query: "retry backoff",
      limit: 5,
      filters: {}
    });

    expect(result.hits.length).toBe(2);
    expect(result.hits[0]?.chunk_id).toBe("a.md#exact");
  });
});
