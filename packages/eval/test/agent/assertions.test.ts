import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateAssertions } from "../../src/agent/assertions.js";
import type { AgentAssertion } from "../../src/agent/types.js";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), "eval-assert-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("evaluateAssertions", () => {
  it("contains: passes when text includes value", async () => {
    const results = await evaluateAssertions("hello world", [
      { type: "contains", value: "hello" }
    ], workspaceDir);
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
  });

  it("contains: fails when text does not include value", async () => {
    const results = await evaluateAssertions("hello world", [
      { type: "contains", value: "goodbye" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(false);
  });

  it("not_contains: passes when text does not include value", async () => {
    const results = await evaluateAssertions("hello world", [
      { type: "not_contains", value: "goodbye" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(true);
  });

  it("not_contains: fails when text includes value", async () => {
    const results = await evaluateAssertions("hello world", [
      { type: "not_contains", value: "hello" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(false);
  });

  it("matches: passes with matching regex", async () => {
    const results = await evaluateAssertions("Error code: 404", [
      { type: "matches", pattern: "\\d{3}" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(true);
  });

  it("matches: supports flags", async () => {
    const results = await evaluateAssertions("Hello World", [
      { type: "matches", pattern: "hello", flags: "i" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(true);
  });

  it("matches: fails when pattern does not match", async () => {
    const results = await evaluateAssertions("hello", [
      { type: "matches", pattern: "^\\d+$" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(false);
  });

  it("script: passes when command exits 0", async () => {
    const results = await evaluateAssertions("", [
      { type: "script", command: "exit 0", name: "trivial" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(true);
  });

  it("script: fails when command exits non-zero", async () => {
    const results = await evaluateAssertions("", [
      { type: "script", command: "exit 1", name: "failing" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(false);
  });

  it("script: runs in workspace directory", async () => {
    await writeFile(path.join(workspaceDir, "marker.txt"), "found");
    const results = await evaluateAssertions("", [
      { type: "script", command: "test -f marker.txt", name: "cwd-check" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(true);
  });

  it("script: captures stderr in failure message", async () => {
    const results = await evaluateAssertions("", [
      { type: "script", command: "echo 'bad stuff' >&2; exit 1", name: "stderr-capture" }
    ], workspaceDir);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain("bad stuff");
  });

  it("evaluates multiple assertions in order", async () => {
    const assertions: AgentAssertion[] = [
      { type: "contains", value: "dub" },
      { type: "not_contains", value: "error" },
      { type: "script", command: "exit 0", name: "ok" }
    ];
    const results = await evaluateAssertions("using dub sdk", assertions, workspaceDir);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
