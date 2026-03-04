import path from "node:path";
import fg from "fast-glob";

export async function listMarkdownFiles(docsDir: string): Promise<string[]> {
  const files = await fg(["**/*.md"], {
    cwd: docsDir,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: ["**/*.template.md", "**/*.template.yaml"],
  });
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function listPromptFiles(docsDir: string): Promise<string[]> {
  const files = await fg(["**/*.template.md", "**/*.template.yaml"], {
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
  return relativePath.replace(/\.template\.(md|yaml)$/u, "");
}

export type PromptTemplateFormat = "markdown" | "yaml";

export function getPromptTemplateFormat(filePath: string): PromptTemplateFormat {
  if (filePath.endsWith(".template.yaml")) {
    return "yaml";
  }
  return "markdown";
}

export function resolvePreferredPromptFiles(
  files: string[],
  docsDir: string,
  onWarning: (message: string) => void,
): string[] {
  const byName = new Map<string, string>();
  for (const filePath of files) {
    const name = derivePromptName(filePath, docsDir);
    const incomingFormat = getPromptTemplateFormat(filePath);
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, filePath);
      continue;
    }

    const existingFormat = getPromptTemplateFormat(existing);
    if (existingFormat === incomingFormat) {
      throw new Error(
        `Duplicate prompt template '${name}' with the same format at '${toPosix(path.relative(docsDir, existing))}' and '${toPosix(path.relative(docsDir, filePath))}'`,
      );
    }

    const yamlPath = incomingFormat === "yaml" ? filePath : existing;
    const markdownPath = incomingFormat === "markdown" ? filePath : existing;
    onWarning(
      `Found both markdown and yaml templates for '${name}' (${toPosix(path.relative(docsDir, markdownPath))} and ${toPosix(path.relative(docsDir, yamlPath))}); using yaml`,
    );
    byName.set(name, yamlPath);
  }

  return [...byName.values()].sort((a, b) => a.localeCompare(b));
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
