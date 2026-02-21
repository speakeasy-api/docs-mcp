import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveSourceCommit(targetDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
      timeout: 5_000,
      windowsHide: true
    });
    const commit = stdout.trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}
