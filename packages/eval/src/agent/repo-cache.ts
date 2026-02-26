import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { DocsRepoSpec } from "./types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPOS_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "repos");

/**
 * Ensures a git repo is cloned (shallow) and returns the absolute path to the
 * docs directory within the clone. Caches by url+ref so repeated runs skip the clone.
 *
 * If the spec includes `docsConfig`, `.docs-mcp.json` is always written (overwriting
 * any existing one) so that config changes in fixtures take effect immediately.
 */
export async function ensureRepo(spec: DocsRepoSpec): Promise<string> {
  const ref = spec.ref ?? "main";
  const docsPath = spec.docsPath ?? ".";

  const cacheKey = createHash("sha256")
    .update(`${spec.url}\0${ref}`)
    .digest("hex")
    .slice(0, 16);

  const repoDir = path.join(REPOS_CACHE_DIR, cacheKey);
  const marker = path.join(repoDir, ".clone-complete");

  // Check for completed clone
  const complete = await stat(marker).then(() => true, () => false);
  if (!complete) {
    // Clean up partial clone if it exists
    await rm(repoDir, { recursive: true, force: true });
    await mkdir(repoDir, { recursive: true });

    console.error(`Cloning ${spec.url} (ref: ${ref}) → ${repoDir}`);
    await gitClone(spec.url, ref, repoDir);
    await writeFile(marker, new Date().toISOString(), "utf8");
  }

  const docsDir = path.join(repoDir, docsPath);

  // Always write .docs-mcp.json when docsConfig is provided so config
  // changes in fixtures take effect without needing to delete the cache.
  if (spec.docsConfig) {
    const configPath = path.join(docsDir, ".docs-mcp.json");
    await mkdir(docsDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(spec.docsConfig, null, 2), "utf8");
  }

  return docsDir;
}

function gitClone(url: string, ref: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["clone", "--depth", "1", "--branch", ref, "--single-branch", url, dir],
      { stdio: ["ignore", "inherit", "inherit"] }
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git clone failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`));
    });
  });
}
