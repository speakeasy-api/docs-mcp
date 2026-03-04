import path from "node:path";
import { describe, expect, it } from "vitest";
import { derivePromptName, listMarkdownFiles, listPromptFiles } from "../src/discovery.js";

const FIXTURE_DOCS_DIR = path.resolve(import.meta.dirname, "../../../tests/fixtures/docs");

describe("docs discovery", () => {
  it("excludes *.template.md files from markdown indexing list", async () => {
    const files = await listMarkdownFiles(FIXTURE_DOCS_DIR);
    const relative = files.map((file) => file.replace(`${FIXTURE_DOCS_DIR}/`, ""));

    expect(relative.some((entry) => entry.endsWith(".template.md"))).toBe(false);
    expect(relative).toContain("guides/authentication.md");
  });

  it("lists prompt files separately", async () => {
    const files = await listPromptFiles(FIXTURE_DOCS_DIR);
    const relative = files.map((file) => file.replace(`${FIXTURE_DOCS_DIR}/`, ""));

    expect(relative).toContain("guides/auth-integration.template.md");
  });

  it("derives prompt name from relative path", () => {
    const promptPath = path.join(FIXTURE_DOCS_DIR, "guides/auth-integration.template.md");
    expect(derivePromptName(promptPath, FIXTURE_DOCS_DIR)).toBe("guides/auth-integration");
  });
});
