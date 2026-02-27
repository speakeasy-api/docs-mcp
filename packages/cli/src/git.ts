import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveSourceCommit(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
      timeout: 5_000,
      windowsHide: true,
    });
    const commit = stdout.trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Derive a corpus identifier from the git repo name and the docs directory's
 * path relative to the repo root. Falls back to the directory basename.
 */
export async function resolveCorpusLabel(docsDir: string): Promise<string> {
  try {
    const opts = { timeout: 5_000, windowsHide: true } as const;

    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["-C", docsDir, "rev-parse", "--show-toplevel"],
      opts,
    );
    const repoRoot = rootOut.trim();

    let repoName: string;
    try {
      const { stdout: remoteOut } = await execFileAsync(
        "git",
        ["-C", docsDir, "remote", "get-url", "origin"],
        opts,
      );
      const url = remoteOut.trim();
      repoName =
        url
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop() ?? path.basename(repoRoot);
    } catch {
      repoName = path.basename(repoRoot);
    }

    const relPath = path.relative(repoRoot, docsDir);
    return relPath ? `${repoName}/${relPath}` : repoName;
  } catch {
    return path.basename(docsDir);
  }
}
