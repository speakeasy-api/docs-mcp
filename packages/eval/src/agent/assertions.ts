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
  workspaceDir: string
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "contains":
        results.push(evaluateContains(finalAnswer, assertion.value));
        break;
      case "not_contains":
        results.push(evaluateNotContains(finalAnswer, assertion.value));
        break;
      case "matches":
        results.push(evaluateMatches(finalAnswer, assertion.pattern, assertion.flags));
        break;
      case "file_contains":
        results.push(await evaluateFileContains(workspaceDir, assertion.path, assertion.value));
        break;
      case "file_matches":
        results.push(await evaluateFileMatches(workspaceDir, assertion.path, assertion.pattern, assertion.flags));
        break;
      case "script":
        if (assertion.when_env && !process.env[assertion.when_env]) {
          results.push({
            assertion,
            passed: true,
            message: `Script "${assertion.name}" skipped (${assertion.when_env} not set)`
          });
        } else {
          results.push(await evaluateScript(assertion.command, assertion.name, workspaceDir));
        }
        break;
    }
  }

  return results;
}

function evaluateContains(text: string, value: string): AssertionResult {
  const passed = text.includes(value);
  return {
    assertion: { type: "contains", value },
    passed,
    message: passed
      ? `Output contains "${value}"`
      : `Output does not contain "${value}"`
  };
}

function evaluateNotContains(text: string, value: string): AssertionResult {
  const passed = !text.includes(value);
  return {
    assertion: { type: "not_contains", value },
    passed,
    message: passed
      ? `Output does not contain "${value}"`
      : `Output unexpectedly contains "${value}"`
  };
}

function evaluateMatches(text: string, pattern: string, flags?: string): AssertionResult {
  const re = new RegExp(pattern, flags);
  const passed = re.test(text);
  return {
    assertion: { type: "matches", pattern, ...(flags !== undefined ? { flags } : {}) },
    passed,
    message: passed
      ? `Output matches /${pattern}/${flags ?? ""}`
      : `Output does not match /${pattern}/${flags ?? ""}`
  };
}

async function evaluateFileContains(
  workspaceDir: string,
  filePath: string,
  value: string
): Promise<AssertionResult> {
  const fullPath = join(workspaceDir, filePath);
  try {
    const content = await readFile(fullPath, "utf-8");
    const passed = content.includes(value);
    return {
      assertion: { type: "file_contains", path: filePath, value },
      passed,
      message: passed
        ? `File "${filePath}" contains "${value}"`
        : `File "${filePath}" does not contain "${value}"`
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      assertion: { type: "file_contains", path: filePath, value },
      passed: false,
      message: code === "ENOENT"
        ? `File "${filePath}" not found in ${workspaceDir}`
        : `File "${filePath}" unreadable: ${code ?? err}`
    };
  }
}

async function evaluateFileMatches(
  workspaceDir: string,
  filePath: string,
  pattern: string,
  flags?: string
): Promise<AssertionResult> {
  const fullPath = join(workspaceDir, filePath);
  try {
    const content = await readFile(fullPath, "utf-8");
    const re = new RegExp(pattern, flags);
    const passed = re.test(content);
    return {
      assertion: { type: "file_matches", path: filePath, pattern, ...(flags !== undefined ? { flags } : {}) },
      passed,
      message: passed
        ? `File "${filePath}" matches /${pattern}/${flags ?? ""}`
        : `File "${filePath}" does not match /${pattern}/${flags ?? ""}`
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      assertion: { type: "file_matches", path: filePath, pattern, ...(flags !== undefined ? { flags } : {}) },
      passed: false,
      message: code === "ENOENT"
        ? `File "${filePath}" not found in ${workspaceDir}`
        : `File "${filePath}" unreadable: ${code ?? err}`
    };
  }
}

async function evaluateScript(
  command: string,
  name: string,
  workspaceDir: string
): Promise<AssertionResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: workspaceDir,
      timeout: SCRIPT_TIMEOUT_MS,
      env: process.env as Record<string, string>,
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      assertion: { type: "script", command, name },
      passed: true,
      message: `Script "${name}" passed${stdout.trim() ? `: ${stdout.trim().slice(0, 200)}` : ""}${stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 200)})` : ""}`
    };
  } catch (err: unknown) {
    const error = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    const detail = error.killed
      ? "timed out"
      : error.stderr?.trim()?.slice(0, 500) || error.stdout?.trim()?.slice(0, 500) || error.message || "unknown error";
    return {
      assertion: { type: "script", command, name },
      passed: false,
      message: `Script "${name}" failed: ${detail}`
    };
  }
}
