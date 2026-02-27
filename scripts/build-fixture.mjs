#!/usr/bin/env node

/**
 * Build the test fixture LanceDB index from sample docs.
 *
 * Usage: node scripts/build-fixture.mjs
 *
 * Requires: `pnpm build` must be run first.
 * If OPENAI_API_KEY is set, builds with OpenAI embeddings for hybrid search.
 * Otherwise, builds FTS-only (hash embeddings).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const docsDir = resolve(rootDir, "tests/fixtures/docs");
const outDir = resolve(rootDir, "tests/fixtures/index");

const cliBin = resolve(rootDir, "packages/cli/dist/index.js");

const embeddingProvider = process.env.OPENAI_API_KEY ? "openai" : "hash";

console.log("Building fixture corpus index...");
console.log(`  Docs: ${docsDir}`);
console.log(`  Output: ${outDir}`);
console.log(`  Embeddings: ${embeddingProvider}`);
console.log();

const args = [
  cliBin,
  "build",
  "--docs-dir",
  docsDir,
  "--out",
  outDir,
  "--description",
  "AcmeAuth documentation — guides for authentication, webhooks, rate limiting, plus per-language SDK references (Python, TypeScript).",
  "--embedding-provider",
  embeddingProvider,
];

if (embeddingProvider === "openai") {
  args.push("--embedding-model", "text-embedding-3-small");
  args.push("--embedding-dimensions", "1536");
}

try {
  const { stdout, stderr } = await execFileAsync("node", args, {
    cwd: rootDir,
    env: process.env,
    timeout: 120000,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  console.log("\nDone! Index written to tests/fixtures/index");
} catch (err) {
  console.error("Build failed:", err.message);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
}
