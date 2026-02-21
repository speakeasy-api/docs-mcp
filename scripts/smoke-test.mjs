#!/usr/bin/env node

/**
 * Smoke test for the delivery gate:
 * 1. Opens the fixture index directly via LanceDbSearchEngine
 * 2. Validates search_docs works (FTS search + filters)
 * 3. Validates get_doc works (chunk retrieval + context)
 * 4. Validates the MCP server boots via stdio and responds to tools/list
 *
 * Usage: node scripts/smoke-test.mjs
 * Requires: `pnpm build` and `node scripts/build-fixture.mjs` must be run first.
 */

import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const indexDir = resolve(rootDir, "tests/fixtures/index");
const dbPath = resolve(indexDir, ".lancedb");
const metadataPath = resolve(indexDir, "metadata.json");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function testSearchEngine() {
  console.log("\n--- Testing Search Engine ---\n");

  const { LanceDbSearchEngine, normalizeMetadata } = await import(
    resolve(rootDir, "packages/core/dist/index.js")
  );

  const metadataRaw = JSON.parse(await readFile(metadataPath, "utf8"));
  const metadata = normalizeMetadata(metadataRaw);

  const engine = await LanceDbSearchEngine.open({
    dbPath,
    metadataKeys: Object.keys(metadata.taxonomy),
  });

  // Test 1: Basic search
  const result1 = await engine.search({
    query: "authentication",
    limit: 5,
    filters: {},
  });
  assert(result1.hits.length > 0, `Basic search returns results (got ${result1.hits.length})`);
  assert(result1.hits[0].chunk_id, `Results have chunk_id: ${result1.hits[0].chunk_id}`);
  assert(result1.hits[0].score > 0, `Results have score > 0: ${result1.hits[0].score}`);
  assert(result1.hits[0].snippet.length > 0, "Results have non-empty snippet");

  // Test 2: Filtered search by language
  const result2 = await engine.search({
    query: "authentication",
    limit: 10,
    filters: { language: "typescript" },
  });
  assert(result2.hits.length > 0, `Filtered search (language=typescript) returns results (got ${result2.hits.length})`);

  // Auto-include rule: should include global-guide results too
  const hasGlobalGuide = result2.hits.some((h) => h.metadata.scope === "global-guide");
  const hasSdkSpecific = result2.hits.some((h) => h.metadata.scope === "sdk-specific");
  assert(hasGlobalGuide, "Auto-include: includes global-guide results with language filter");
  assert(hasSdkSpecific, "Auto-include: includes sdk-specific results matching language");

  // Test 3: Search with both language and scope (no auto-include)
  const result3 = await engine.search({
    query: "webhook",
    limit: 10,
    filters: { language: "python", scope: "sdk-specific" },
  });
  if (result3.hits.length > 0) {
    const allSdkSpecific = result3.hits.every((h) => h.metadata.scope === "sdk-specific");
    assert(allSdkSpecific, "With explicit scope filter, all results are sdk-specific");
  } else {
    assert(true, "Scoped search returned 0 results (acceptable for small fixture)");
  }

  // Test 4: getDoc
  const targetChunkId = result1.hits[0].chunk_id;
  const doc1 = await engine.getDoc({ chunk_id: targetChunkId });
  assert(doc1.text.length > 0, `getDoc returns content for ${targetChunkId}`);

  // Test 5: getDoc with context
  const doc2 = await engine.getDoc({ chunk_id: targetChunkId, context: 1 });
  assert(doc2.text.length >= doc1.text.length, "getDoc with context=1 returns at least as much content");

  // Test 6: Zero-result search gives hint
  const result4 = await engine.search({
    query: "zzzznonexistent",
    limit: 5,
    filters: {},
  });
  assert(result4.hits.length === 0, "Non-matching query returns 0 hits");
  assert(result4.hint !== null, "Zero-result search includes hint");

  // Test 7: Pagination cursor
  const result5 = await engine.search({
    query: "authentication",
    limit: 2,
    filters: {},
  });
  if (result5.next_cursor) {
    assert(true, `Pagination cursor generated`);
    const result6 = await engine.search({
      query: "authentication",
      limit: 2,
      cursor: result5.next_cursor,
      filters: {},
    });
    assert(result6.hits.length > 0, `Cursor pagination returns page 2 results (got ${result6.hits.length})`);
  } else {
    assert(true, "No pagination cursor (few results) — OK");
  }
}

async function testMcpServerBoot() {
  console.log("\n--- Testing MCP Server Boot ---\n");

  return new Promise((resolvePromise) => {
    const serverBin = resolve(rootDir, "packages/server/dist/bin.js");
    const proc = spawn("node", [serverBin, "--index-dir", indexDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Send a JSON-RPC initialize request
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.1.0" },
      },
    });

    proc.stdin.write(initRequest + "\n");

    // Wait for response, then send tools/list
    setTimeout(() => {
      const listToolsRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      proc.stdin.write(listToolsRequest + "\n");
    }, 1000);

    // After 3 seconds, check output and kill
    setTimeout(() => {
      proc.kill();

      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      let initResponse = null;
      let toolsResponse = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) initResponse = parsed;
          if (parsed.id === 2) toolsResponse = parsed;
        } catch {
          // ignore non-JSON lines
        }
      }

      assert(initResponse !== null, "MCP server responds to initialize");
      if (initResponse) {
        const serverName = initResponse.result?.serverInfo?.name;
        assert(
          typeof serverName === "string" && serverName.length > 0,
          `Server reports a name: ${serverName}`
        );
      }

      assert(toolsResponse !== null, "MCP server responds to tools/list");
      if (toolsResponse) {
        const tools = toolsResponse.result?.tools ?? [];
        const toolNames = tools.map((t) => t.name);
        assert(toolNames.includes("search_docs"), "tools/list includes search_docs");
        assert(toolNames.includes("get_doc"), "tools/list includes get_doc");

        // Verify search_docs has dynamic taxonomy fields
        const searchTool = tools.find((t) => t.name === "search_docs");
        if (searchTool) {
          const props = searchTool.inputSchema?.properties ?? {};
          assert("language" in props, "search_docs schema has 'language' property from taxonomy");
          assert("scope" in props, "search_docs schema has 'scope' property from taxonomy");
        }
      }

      resolvePromise();
    }, 3000);
  });
}

async function main() {
  console.log("=== MCP-Docs Smoke Test ===");

  await testSearchEngine();
  await testMcpServerBoot();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
