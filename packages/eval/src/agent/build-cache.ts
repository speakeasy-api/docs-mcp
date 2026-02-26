import { createHash } from "node:crypto";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_CACHE_DIR = "node_modules/.cache/docs-mcp-eval";

/**
 * Ensures an index exists for the given docs directory, building it if necessary.
 * Returns the path to the built index directory.
 */
export async function ensureIndex(
  docsDir: string,
  cliBinPath: string,
  cacheDir?: string
): Promise<string> {
  const resolvedCacheDir = cacheDir ?? path.resolve(DEFAULT_CACHE_DIR);
  const cacheKey = await computeCacheKey(docsDir);
  const indexDir = path.join(resolvedCacheDir, cacheKey);
  const metadataPath = path.join(indexDir, "metadata.json");

  try {
    await stat(metadataPath);
    // Cache hit
    return indexDir;
  } catch {
    // Cache miss — build the index
  }

  await mkdir(indexDir, { recursive: true });

  console.error(`Building index for ${docsDir} → ${indexDir}`);
  await runBuild(cliBinPath, docsDir, indexDir);

  return indexDir;
}

async function computeCacheKey(docsDir: string): Promise<string> {
  const hash = createHash("sha256");

  // Hash file listing (relative paths + sizes + mtimes)
  const entries = await collectFiles(docsDir);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const entry of entries) {
    hash.update(`${entry.rel}\0${entry.size}\0${entry.mtimeMs}\0`);
  }

  // Hash .docs-mcp.json if present
  const configPath = path.join(docsDir, ".docs-mcp.json");
  try {
    const configContent = await readFile(configPath, "utf8");
    hash.update(configContent);
  } catch {
    // No config file — that's fine
  }

  return hash.digest("hex").slice(0, 16);
}

interface FileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
}

async function collectFiles(dir: string, base?: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const items = await readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const rel = base ? path.join(base, item.name) : item.name;

    if (item.isDirectory()) {
      const sub = await collectFiles(fullPath, rel);
      entries.push(...sub);
    } else if (item.isFile()) {
      const s = await stat(fullPath);
      entries.push({ rel, size: s.size, mtimeMs: s.mtimeMs });
    }
  }

  return entries;
}

function runBuild(cliBinPath: string, docsDir: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliBinPath, "build", "--docs-dir", docsDir, "--out", outDir], {
      env: process.env as Record<string, string>,
      stdio: ["ignore", "inherit", "inherit"]
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Index build failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`));
    });
  });
}
