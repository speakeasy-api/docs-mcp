import path from "node:path";
import fg from "fast-glob";

export async function listMarkdownFiles(docsDir: string): Promise<string[]> {
  const files = await fg(["**/*.md"], {
    cwd: docsDir,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: ["**/*.template.md"],
  });
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function listPromptFiles(docsDir: string): Promise<string[]> {
  const files = await fg(["**/*.template.md"], {
    cwd: docsDir,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export function derivePromptName(filePath: string, docsDir: string): string {
  const relativePath = toPosix(path.relative(docsDir, filePath));
  return relativePath.replace(/\.template\.md$/u, "");
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
