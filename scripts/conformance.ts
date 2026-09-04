#!/usr/bin/env node
/**
 * Runs the official MCP conformance suite against a docs-mcp HTTP server for
 * each spec revision in the matrix and compares the outcome with the
 * expected-failure allowlist for that revision.
 *
 *   node scripts/conformance.ts [--requirements 2026-07-28]... [--mode stateless|sessions]...
 *
 * A scenario that fails without an allowlist entry fails the run. A scenario
 * that passes despite an allowlist entry is reported so the entry can be
 * removed. Scenarios the suite itself does not score for the revision are
 * reported but never affect the verdict.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverBin = path.join(repoRoot, "packages/server/dist/bin.js");
const indexDir = path.join(repoRoot, "tests/fixtures/index");
const expectedDir = path.join(repoRoot, "conformance/expected-failures");
// Built from the escape code so no control character appears in the source.
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Mode = "stateless" | "sessions";

interface ScenarioOutcome {
  name: string;
  passed: number;
  failed: number;
  scored: boolean;
}

interface RunResult {
  revision: string;
  mode: Mode;
  scenarios: ScenarioOutcome[];
  unexpectedFailures: string[];
  stalePasses: string[];
}

const { values } = parseArgs({
  options: {
    requirements: { type: "string", multiple: true },
    mode: { type: "string", multiple: true },
    port: { type: "string", default: "20410" },
    verbose: { type: "boolean", default: false },
  },
});

const revisions =
  values.requirements && values.requirements.length > 0
    ? values.requirements
    : readdirSync(expectedDir)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => f.replace(/\.txt$/, ""))
        .sort();
const modes: Mode[] =
  values.mode && values.mode.length > 0
    ? values.mode.map((m) => {
        if (m !== "stateless" && m !== "sessions") {
          throw new Error(`unknown mode '${m}' (expected stateless or sessions)`);
        }
        return m;
      })
    : ["stateless", "sessions"];
let port = Number.parseInt(values.port ?? "20410", 10);

if (!existsSync(serverBin)) {
  fail(`server build not found at ${serverBin}; run 'pnpm build' first`);
}
if (!existsSync(indexDir)) {
  fail(`fixture index not found at ${indexDir}; run 'mise run index-fixtures' first`);
}

const results: RunResult[] = [];
for (const revision of revisions) {
  const expected = readExpectedFailures(revision);
  for (const mode of modes) {
    const result = await runOnce(revision, mode, port++, expected);
    results.push(result);
    printResult(result);
  }
}

const failed = results.filter((r) => r.unexpectedFailures.length > 0);
const stale = results.filter((r) => r.stalePasses.length > 0);
console.log("");
for (const r of stale) {
  console.log(
    `note: ${r.revision} (${r.mode}) passes ${r.stalePasses.length} allowlisted scenario(s); ` +
      `remove from conformance/expected-failures/${r.revision}.txt: ${r.stalePasses.join(", ")}`,
  );
}
if (failed.length > 0) {
  for (const r of failed) {
    console.log(
      `FAIL ${r.revision} (${r.mode}): unexpected failures: ${r.unexpectedFailures.join(", ")}`,
    );
  }
  process.exit(1);
}
console.log(`OK: ${results.length} run(s) matched their expected-failure allowlists`);

async function runOnce(
  revision: string,
  mode: Mode,
  serverPort: number,
  expected: Map<string, string>,
): Promise<RunResult> {
  console.log(`\n=== conformance ${revision} (${mode}) on port ${serverPort} ===`);
  const server = await startServer(mode, serverPort);
  try {
    const output = await runSuite(revision, serverPort);
    const scenarios = parseSummary(output);
    if (scenarios.length === 0) {
      console.log(output);
      fail(`no scenario summary found in conformance output for ${revision} (${mode})`);
    }
    const unexpectedFailures = scenarios
      .filter((s) => s.scored && s.failed > 0 && !expected.has(s.name))
      .map((s) => s.name);
    const stalePasses = scenarios
      .filter((s) => s.scored && s.failed === 0 && expected.has(s.name))
      .map((s) => s.name);
    return { revision, mode, scenarios, unexpectedFailures, stalePasses };
  } finally {
    await stopServer(server);
  }
}

function readExpectedFailures(revision: string): Map<string, string> {
  const file = path.join(expectedDir, `${revision}.txt`);
  if (!existsSync(file)) {
    fail(`no expected-failure allowlist for ${revision} at ${file}`);
  }
  const entries = new Map<string, string>();
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name, ...reason] = line.split(/\s+#\s*/);
    if (name) entries.set(name, reason.join(" ").trim());
  }
  return entries;
}

function startServer(mode: Mode, serverPort: number): Promise<ChildProcess> {
  const args = [
    serverBin,
    "--index-dir",
    indexDir,
    "--transport",
    "http",
    "--port",
    String(serverPort),
    "--allowed-hosts",
    "localhost,127.0.0.1",
    "--log-level",
    "warn",
  ];
  if (mode === "stateless") args.push("--stateless");
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: values.verbose ? "inherit" : ["ignore", "ignore", "inherit"],
  });
  return waitForHealthy(child, serverPort);
}

async function waitForHealthy(child: ChildProcess, serverPort: number): Promise<ChildProcess> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGKILL");
  fail(`server did not become healthy on port ${serverPort} within 30s`);
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

function runSuite(revision: string, serverPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "conformance",
        "server",
        "--url",
        `http://127.0.0.1:${serverPort}/mcp`,
        "--requirements",
        revision,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (values.verbose) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (values.verbose) process.stderr.write(chunk);
    });
    child.on("error", reject);
    // The suite exits non-zero whenever any scenario fails; the allowlist
    // comparison decides the verdict, so the exit code is ignored here.
    child.on("exit", () => resolve(output));
  });
}

/**
 * Parses the suite's summary block: one `✓/✗ name: N passed, M failed` line
 * per scenario, followed by an optional "Not scored" section listing the
 * scenarios the revision does not require.
 */
function parseSummary(raw: string): ScenarioOutcome[] {
  const text = raw.replace(ansiEscape, "");
  const summaryStart = text.lastIndexOf("=== SUMMARY ===");
  if (summaryStart === -1) return [];
  const lines = text.slice(summaryStart).split("\n");
  const scenarios = new Map<string, ScenarioOutcome>();
  const unscored = new Set<string>();
  let inUnscored = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const scenario = /^[✓✗]\s+(\S+):\s+(\d+) passed,\s+(\d+) failed/.exec(trimmed);
    if (scenario && !inUnscored) {
      scenarios.set(scenario[1]!, {
        name: scenario[1]!,
        passed: Number(scenario[2]),
        failed: Number(scenario[3]),
        scored: true,
      });
      continue;
    }
    if (/^Not scored for /.test(trimmed)) {
      inUnscored = true;
      continue;
    }
    if (inUnscored) {
      const entry = /^[✓✗]\s+(\S+)\s+\(/.exec(trimmed);
      if (entry) unscored.add(entry[1]!);
    }
  }
  for (const name of unscored) {
    const outcome = scenarios.get(name);
    if (outcome) outcome.scored = false;
  }
  return [...scenarios.values()];
}

function printResult(result: RunResult): void {
  const scored = result.scenarios.filter((s) => s.scored);
  const passing = scored.filter((s) => s.failed === 0).length;
  console.log(
    `${result.revision} (${result.mode}): ${passing}/${scored.length} scored scenarios passing, ` +
      `${result.scenarios.length - scored.length} not scored`,
  );
  for (const s of result.scenarios) {
    const status =
      s.failed === 0
        ? "pass"
        : result.unexpectedFailures.includes(s.name)
          ? "FAIL"
          : "fail (expected)";
    const scoredNote = s.scored ? "" : " [not scored]";
    console.log(`  ${status.padEnd(16)} ${s.name}${scoredNote}`);
  }
}

function fail(message: string): never {
  console.error(`conformance: ${message}`);
  process.exit(1);
}
