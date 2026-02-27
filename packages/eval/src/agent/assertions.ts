import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAssertion, AssertionResult } from "./types.js";

const execFileAsync = promisify(execFile);

const SCRIPT_TIMEOUT_MS = 30_000;

export async function evaluateAssertions(
  finalAnswer: string,
  assertions: AgentAssertion[],
  workspaceDir: string,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "contains":
        results.push(evaluateContains(assertion, finalAnswer));
        break;
      case "not_contains":
        results.push(evaluateNotContains(assertion, finalAnswer));
        break;
      case "matches":
        results.push(evaluateMatches(assertion, finalAnswer));
        break;
      case "file_contains":
        results.push(await evaluateFileContains(assertion, workspaceDir));
        break;
      case "file_matches":
        results.push(await evaluateFileMatches(assertion, workspaceDir));
        break;
      case "script":
        if (assertion.when_env && !process.env[assertion.when_env]) {
          results.push({
            assertion,
            passed: true,
            message: `Script "${assertion.name}" skipped (${assertion.when_env} not set)`,
          });
        } else {
          results.push(await evaluateScript(assertion, workspaceDir));
        }
        break;
    }
  }

  return results;
}

function evaluateContains(
  assertion: AgentAssertion & { type: "contains" },
  text: string,
): AssertionResult {
  const passed = text.includes(assertion.value);
  return {
    assertion,
    passed,
    message: passed
      ? `Output contains "${assertion.value}"`
      : `Output does not contain "${assertion.value}"`,
  };
}

function evaluateNotContains(
  assertion: AgentAssertion & { type: "not_contains" },
  text: string,
): AssertionResult {
  const passed = !text.includes(assertion.value);
  return {
    assertion,
    passed,
    message: passed
      ? `Output does not contain "${assertion.value}"`
      : `Output unexpectedly contains "${assertion.value}"`,
  };
}

function evaluateMatches(
  assertion: AgentAssertion & { type: "matches" },
  text: string,
): AssertionResult {
  const re = new RegExp(assertion.pattern, assertion.flags);
  const passed = re.test(text);
  return {
    assertion,
    passed,
    message: passed
      ? `Output matches /${assertion.pattern}/${assertion.flags ?? ""}`
      : `Output does not match /${assertion.pattern}/${assertion.flags ?? ""}`,
  };
}

async function evaluateFileContains(
  assertion: AgentAssertion & { type: "file_contains" },
  workspaceDir: string,
): Promise<AssertionResult> {
  const fullPath = join(workspaceDir, assertion.path);
  try {
    const content = await readFile(fullPath, "utf-8");
    const passed = content.includes(assertion.value);
    return {
      assertion,
      passed,
      message: passed
        ? `File "${assertion.path}" contains "${assertion.value}"`
        : `File "${assertion.path}" does not contain "${assertion.value}"`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      assertion,
      passed: false,
      message:
        code === "ENOENT"
          ? `File "${assertion.path}" not found in ${workspaceDir}`
          : `File "${assertion.path}" unreadable: ${code ?? err}`,
    };
  }
}

async function evaluateFileMatches(
  assertion: AgentAssertion & { type: "file_matches" },
  workspaceDir: string,
): Promise<AssertionResult> {
  const fullPath = join(workspaceDir, assertion.path);
  try {
    const content = await readFile(fullPath, "utf-8");
    const re = new RegExp(assertion.pattern, assertion.flags);
    const passed = re.test(content);
    return {
      assertion,
      passed,
      message: passed
        ? `File "${assertion.path}" matches /${assertion.pattern}/${assertion.flags ?? ""}`
        : `File "${assertion.path}" does not match /${assertion.pattern}/${assertion.flags ?? ""}`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      assertion,
      passed: false,
      message:
        code === "ENOENT"
          ? `File "${assertion.path}" not found in ${workspaceDir}`
          : `File "${assertion.path}" unreadable: ${code ?? err}`,
    };
  }
}

async function evaluateScript(
  assertion: AgentAssertion & { type: "script" },
  workspaceDir: string,
): Promise<AssertionResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", assertion.command], {
      cwd: workspaceDir,
      timeout: SCRIPT_TIMEOUT_MS,
      env: process.env as Record<string, string>,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      assertion,
      passed: true,
      message: `Script "${assertion.name}" passed${stdout.trim() ? `: ${stdout.trim().slice(0, 200)}` : ""}${stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 200)})` : ""}`,
    };
  } catch (err: unknown) {
    const error = err as {
      code?: number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const detail = error.killed
      ? "timed out"
      : error.stderr?.trim()?.slice(0, 500) ||
        error.stdout?.trim()?.slice(0, 500) ||
        error.message ||
        "unknown error";
    return {
      assertion,
      passed: false,
      message: `Script "${assertion.name}" failed: ${detail}`,
    };
  }
}
