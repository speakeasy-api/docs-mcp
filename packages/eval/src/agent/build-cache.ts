import { createHash } from "node:crypto";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { IndexConfig } from "./types.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "indexes");

/**
 * Maps each IndexConfig field to a function that produces CLI flags for the build command.
 * `satisfies` enforces exhaustive coverage — adding a field to IndexConfig without
 * adding a mapper here is a compile error.
 */
const INDEX_CONFIG_FLAGS = {
  description: (v: string) => ["--description", v],
  toolDescriptions: (v: { search_docs?: string; get_doc?: string }) => [
    ...(v.search_docs ? ["--tool-description-search", v.search_docs] : []),
    ...(v.get_doc ? ["--tool-description-get-doc", v.get_doc] : []),
  ],
  mcpServerInstructions: (v: string) => ["--mcp-server-instructions", v],
} satisfies {
  [K in keyof Required<IndexConfig>]: (value: NonNullable<IndexConfig[K]>) => string[];
};

function configToBuildArgs(config: IndexConfig): string[] {
  const args: string[] = [];
  for (const key of Object.keys(INDEX_CONFIG_FLAGS) as (keyof IndexConfig)[]) {
    const value = config[key];
    if (value != null) {
      // Safe: satisfies guarantees each mapper matches its IndexConfig field type.
      args.push(...INDEX_CONFIG_FLAGS[key](value as never));
    }
  }
  return args;
}

/**
 * Ensures an index exists for the given docs directory, building it if necessary.
 * Returns the path to the built index directory.
 */
export async function ensureIndex(
  docsDir: string,
  cliBinPath: string,
  cacheDir?: string,
  config?: IndexConfig,
): Promise<string> {
  const resolvedCacheDir = cacheDir ?? path.resolve(DEFAULT_CACHE_DIR);
  const cacheKey = await computeCacheKey(docsDir, config);
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
  await runBuild(cliBinPath, docsDir, indexDir, config);

  return indexDir;
}

async function computeCacheKey(docsDir: string, config?: IndexConfig): Promise<string> {
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

  // Hash all index config fields — new fields are automatically included
  if (config) {
    hash.update(`\0index_config\0${JSON.stringify(config)}`);
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

function runBuild(
  cliBinPath: string,
  docsDir: string,
  outDir: string,
  config?: IndexConfig,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [cliBinPath, "build", "--docs-dir", docsDir, "--out", outDir];
    if (config) {
      args.push(...configToBuildArgs(config));
    }
    const child = spawn("node", args, {
      env: process.env as Record<string, string>,
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Index build failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
        ),
      );
    });
  });
}
