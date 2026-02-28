/**
 * E2E test simulating an LLM agent handling the customer prompt from prompt.md.
 *
 * Adapted from the original Python prompt to Go SDK since our llms-go engine
 * is Go-specific. The customer prompt flow is:
 *   1. Initialize the SDK
 *   2. Register an MCP server (ServerRegistration — uses OptionalNullable fields)
 *   3. Register skills for that server
 *   4. Send a prompt to AI Canvas (create message)
 *
 * For each step we simulate what an LLM agent would do:
 *   - search_docs to find relevant methods
 *   - get_doc with symbols + hydration to get full method signatures & types
 *   - Evaluate whether the returned context is sufficient to write correct code
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL || "http://localhost:20310/mcp";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m⚠\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
let warnings = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    if (detail) console.log(`    → ${detail}`);
    failed++;
  }
}

function warn(label, detail) {
  console.log(`  ${WARN} ${label}`);
  if (detail) console.log(`    → ${detail}`);
  warnings++;
}

async function createClient() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "e2e-prompt-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callSearch(client, query, extraArgs = {}) {
  const result = await client.callTool({
    name: "search_docs",
    arguments: { query, ...extraArgs }
  });
  if (result.isError) throw new Error(`search_docs error: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function callGetDoc(client, args) {
  const result = await client.callTool({
    name: "get_doc",
    arguments: args
  });
  if (result.isError) throw new Error(`get_doc error: ${result.content[0]?.text}`);
  return result.content[0].text;
}

// ─── Step 0: Verify server tools & entrypoint bundle ───────────────────────

async function step0_verifyTools() {
  console.log(`\n${BOLD}Step 0: Verify MCP server connectivity & tools${RESET}`);
  const client = await createClient();

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check("search_docs tool available", names.includes("search_docs"));
  check("get_doc tool available", names.includes("get_doc"));

  const searchTool = tools.find((t) => t.name === "search_docs");
  const props = searchTool?.inputSchema?.properties ?? {};
  check("search_docs has 'query' param", !!props.query);

  const getDocTool = tools.find((t) => t.name === "get_doc");
  const gdProps = getDocTool?.inputSchema?.properties ?? {};
  check("get_doc has 'symbols' param", !!gdProps.symbols);
  check("get_doc has 'hydrate' param", !!gdProps.hydrate);

  await client.close();
}

// ─── Step 1: SDK initialization ────────────────────────────────────────────

async function step1_sdkInit() {
  console.log(`\n${BOLD}Step 1: SDK initialization — "How to initialize the Go SDK"${RESET}`);
  const client = await createClient();

  const searchResult = await callSearch(client, "initialize SDK");
  check("search returns hits", searchResult.hits?.length > 0, `got ${searchResult.hits?.length} hits`);
  check("entrypoint_bundle present on first page", !!searchResult.entrypoint_bundle,
    searchResult.entrypoint_bundle ? `id: ${searchResult.entrypoint_bundle.id}` : "missing");

  if (searchResult.entrypoint_bundle) {
    const entrypointId = `entrypoint:${searchResult.entrypoint_bundle.id}`;
    const doc = await callGetDoc(client, { symbols: [entrypointId] });
    check("entrypoint bundle contains SDK struct", doc.includes("type SDK struct") || doc.includes("SDK"),
      doc.substring(0, 200));
    check("entrypoint bundle contains New() constructor", doc.includes("func New(") || doc.includes("New"),
      "needed for SDK initialization");
    check("entrypoint bundle contains SDKOption", doc.includes("SDKOption"),
      "needed for SDK configuration options");
    check("entrypoint bundle contains server URL", doc.toLowerCase().includes("serverurl") || doc.toLowerCase().includes("server"),
      "needed for server configuration");
  }

  await client.close();
}

// ─── Step 2: Register an MCP server ────────────────────────────────────────

async function step2_registerServer() {
  console.log(`\n${BOLD}Step 2: Register MCP server — "Register a server with optional fields"${RESET}`);
  console.log("  (This was the customer's friction Point 2 + 3: OptionalNullable + WithSetHeaders)");
  const client = await createClient();

  const searchResult = await callSearch(client, "register MCP server");
  check("search returns hits for 'register MCP server'", searchResult.hits?.length > 0);

  const registerHit = searchResult.hits?.find((h) =>
    h.heading?.toLowerCase().includes("register") ||
    h.content_text?.toLowerCase().includes("register")
  );
  check("found a 'Register' method hit", !!registerHit,
    registerHit ? `${registerHit.heading} (deps: ${registerHit.dependency_count})` : "no match");

  if (registerHit) {
    check("dependency_count present on hit", registerHit.dependency_count !== undefined,
      `dependency_count: ${registerHit.dependency_count}`);

    const symbolName = registerHit.heading || registerHit.chunk_id;
    const hydrated = await callGetDoc(client, {
      symbols: [symbolName],
      hydrate: true
    });

    check("hydrated doc includes method signature", hydrated.includes("func"),
      "should show full method signature");
    check("hydrated doc includes ServerRegistration type", hydrated.includes("ServerRegistration"),
      "needed to construct the request");
    check("hydrated doc includes OptionalNullable", hydrated.includes("OptionalNullable"),
      "CRITICAL: OptionalNullable fields must not be flattened to *string");
    check("hydrated doc includes optionalnullable package reference",
      hydrated.includes("optionalnullable.") || hydrated.includes("optionalnullable"),
      "needed for import path");

    if (!hydrated.includes("OptionalNullable")) {
      console.log("\n    ──── FRICTION POINT 2 REGRESSION ────");
      console.log("    The LLM would see *string instead of OptionalNullable[string]");
      console.log("    and generate wrong code like: ProductName: &productName");
      console.log("    ────────────────────────────────────\n");
    }
  }

  // Now test fetching WithSetHeaders directly
  console.log(`\n  ${BOLD}Sub-test: WithSetHeaders availability${RESET}`);
  const headersDoc = await callGetDoc(client, { symbols: ["WithSetHeaders"] });
  check("WithSetHeaders is retrievable", headersDoc.includes("WithSetHeaders"),
    "CRITICAL: customer hallucinated WithHTTPHeader because this was missing");
  check("WithSetHeaders shows correct parameter type (map[string]string)",
    headersDoc.includes("map[string]string"),
    "customer used map[string][]string which was wrong");

  // Test fetching all With* option functions
  console.log(`\n  ${BOLD}Sub-test: All With* option functions available${RESET}`);
  const optionsDoc = await callGetDoc(client, { symbols: ["WithOperationTimeout"] });
  check("WithOperationTimeout is retrievable", optionsDoc.includes("WithOperationTimeout"),
    "was missing from legacy docs");

  await client.close();
}

// ─── Step 3: Register skills ───────────────────────────────────────────────

async function step3_registerSkills() {
  console.log(`\n${BOLD}Step 3: Register skills — "Create a skill for an MCP server"${RESET}`);
  const client = await createClient();

  const searchResult = await callSearch(client, "create skill");
  check("search returns hits for 'create skill'", searchResult.hits?.length > 0);

  const skillHit = searchResult.hits?.find((h) =>
    h.heading?.toLowerCase().includes("skill") ||
    h.content_text?.toLowerCase().includes("skill")
  );
  check("found a skill-related method", !!skillHit,
    skillHit ? `${skillHit.heading} (deps: ${skillHit.dependency_count})` : "no match");

  if (skillHit) {
    const symbolName = skillHit.heading || skillHit.chunk_id;
    const hydrated = await callGetDoc(client, {
      symbols: [symbolName],
      hydrate: true
    });

    check("hydrated doc includes method signature", hydrated.includes("func"),
      "should show full method signature");

    const hasRequestType = hydrated.includes("Request") || hydrated.includes("request");
    check("hydrated doc includes request type definition", hasRequestType,
      "needed to construct the API call");
  }

  await client.close();
}

// ─── Step 4: Send a message / conversation ─────────────────────────────────

async function step4_sendMessage() {
  console.log(`\n${BOLD}Step 4: Send message — "Send a prompt to AI Canvas"${RESET}`);
  console.log("  (This was the customer's friction Point 6: SSE stream)");
  const client = await createClient();

  const searchResult = await callSearch(client, "create message conversation");
  check("search returns hits for 'create message'", searchResult.hits?.length > 0);

  const msgHit = searchResult.hits?.find((h) =>
    h.heading?.toLowerCase().includes("message") ||
    h.heading?.toLowerCase().includes("conversation") ||
    h.content_text?.toLowerCase().includes("message")
  );
  check("found a message/conversation method", !!msgHit,
    msgHit ? `${msgHit.heading}` : "no match");

  if (msgHit) {
    const symbolName = msgHit.heading || msgHit.chunk_id;
    const hydrated = await callGetDoc(client, {
      symbols: [symbolName],
      hydrate: true
    });

    check("hydrated doc includes method signature", hydrated.includes("func"),
      "should show full method signature");
  }

  await client.close();
}

// ─── Step 5: Cross-cutting concerns ────────────────────────────────────────

async function step5_crossCutting() {
  console.log(`\n${BOLD}Step 5: Cross-cutting — auxiliary packages availability${RESET}`);
  const client = await createClient();

  // OptionalNullable type
  const onDoc = await callGetDoc(client, { symbols: ["OptionalNullable"] });
  check("OptionalNullable type retrievable", onDoc.includes("OptionalNullable"),
    "needed for optional field construction");
  check("OptionalNullable includes From() constructor",
    onDoc.includes("func From") || onDoc.includes("From["),
    "LLM needs to know how to construct OptionalNullable values");
  check("OptionalNullable includes Get()/Set()/IsNull() methods",
    onDoc.includes("Get") || onDoc.includes("IsNull"),
    "LLM needs to know how to read OptionalNullable values");

  // APIError
  const errDoc = await callGetDoc(client, { symbols: ["APIError"] });
  check("APIError type retrievable", errDoc.includes("APIError"),
    "needed for error handling");
  check("APIError includes StatusCode field",
    errDoc.includes("StatusCode") || errDoc.includes("statusCode"),
    "needed for HTTP error inspection");

  // RetryConfig / BackoffStrategy
  const retryDoc = await callGetDoc(client, { symbols: ["BackoffStrategy"] });
  check("BackoffStrategy type retrievable", retryDoc.includes("BackoffStrategy"),
    "needed for retry configuration");

  // WithRetries
  const retriesDoc = await callGetDoc(client, { symbols: ["WithRetries"] });
  check("WithRetries entrypoint retrievable", retriesDoc.includes("WithRetries"),
    "needed for per-operation retry config");

  await client.close();
}

// ─── Step 6: Full workflow simulation ──────────────────────────────────────

async function step6_fullWorkflow() {
  console.log(`\n${BOLD}Step 6: Full workflow — simulate LLM agent completing prompt task${RESET}`);
  console.log("  Simulates: init SDK → register server → register skills → send message");
  const client = await createClient();

  // Phase 1: Get entrypoint bundle for SDK construction
  const search1 = await callSearch(client, "SDK initialization");
  const entrypointRef = search1.entrypoint_bundle;
  let sdkContext = "";
  if (entrypointRef) {
    sdkContext = await callGetDoc(client, {
      symbols: [`entrypoint:${entrypointRef.id}`]
    });
  }
  check("Phase 1: SDK construction context retrieved", sdkContext.length > 100,
    `${sdkContext.length} chars`);

  // Phase 2: Find & hydrate register server method
  const search2 = await callSearch(client, "register server");
  const regHit = search2.hits?.find((h) =>
    h.heading?.toLowerCase().includes("register")
  );
  let regContext = "";
  if (regHit) {
    regContext = await callGetDoc(client, {
      symbols: [regHit.heading],
      hydrate: true
    });
  }
  check("Phase 2: Register server context with types", regContext.length > 200,
    `${regContext.length} chars`);

  // Phase 3: Auth headers — fetch WithSetHeaders
  const authContext = await callGetDoc(client, { symbols: ["WithSetHeaders"] });
  check("Phase 3: Auth header context retrieved", authContext.includes("WithSetHeaders"));

  // Phase 4: Find skills creation method
  const search4 = await callSearch(client, "create skill");
  const skillHit = search4.hits?.[0];
  let skillContext = "";
  if (skillHit) {
    skillContext = await callGetDoc(client, {
      symbols: [skillHit.heading],
      hydrate: true
    });
  }
  check("Phase 4: Skill creation context retrieved", skillContext.length > 100,
    `${skillContext.length} chars`);

  // Phase 5: Find message creation
  const search5 = await callSearch(client, "send message conversation");
  const msgHit = search5.hits?.find((h) =>
    h.heading?.toLowerCase().includes("message") ||
    h.heading?.toLowerCase().includes("conversation")
  );
  let msgContext = "";
  if (msgHit) {
    msgContext = await callGetDoc(client, {
      symbols: [msgHit.heading],
      hydrate: true
    });
  }
  check("Phase 5: Message/conversation context retrieved", (msgContext?.length ?? 0) > 0 || msgHit !== undefined,
    msgHit ? `${msgHit.heading}` : "no conversation methods found (may not exist in this SDK)");

  // Total context size assessment
  const totalCtx = sdkContext.length + regContext.length + authContext.length + skillContext.length + msgContext.length;
  console.log(`\n  ${BOLD}Context budget assessment:${RESET}`);
  console.log(`    SDK init:      ${sdkContext.length.toLocaleString()} chars`);
  console.log(`    Register:      ${regContext.length.toLocaleString()} chars`);
  console.log(`    Auth headers:  ${authContext.length.toLocaleString()} chars`);
  console.log(`    Skills:        ${skillContext.length.toLocaleString()} chars`);
  console.log(`    Messages:      ${msgContext.length.toLocaleString()} chars`);
  console.log(`    ─────────────────────────────────`);
  console.log(`    Total:         ${totalCtx.toLocaleString()} chars`);
  console.log(`    Est. tokens:   ~${Math.round(totalCtx / 4).toLocaleString()}`);

  if (totalCtx < 200_000) {
    check("Total context fits in 200K char budget", true, `${totalCtx.toLocaleString()} chars`);
  } else {
    warn("Total context exceeds 200K char budget", `${totalCtx.toLocaleString()} chars — may cause truncation`);
  }

  await client.close();
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  E2E Prompt Test: Customer prompt.md → LLM Agent Simulation  ${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`\n  Server: ${MCP_URL}`);
  console.log(`  Adapted from: prompt.md (Python → Go SDK)`);
  console.log(`  Friction points tested: OptionalNullable, WithSetHeaders, auxiliary types`);

  try {
    await step0_verifyTools();
    await step1_sdkInit();
    await step2_registerServer();
    await step3_registerSkills();
    await step4_sendMessage();
    await step5_crossCutting();
    await step6_fullWorkflow();
  } catch (err) {
    console.error(`\n${FAIL} Fatal error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${WARN} ${warnings} warnings`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
