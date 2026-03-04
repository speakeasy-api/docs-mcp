import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePromptMarkdown } from "../src/prompt.js";

const FIXTURE_PROMPT_PATH = path.resolve(
  import.meta.dirname,
  "../../../tests/fixtures/docs/guides/auth-integration.template.md",
);

describe("parsePromptMarkdown", () => {
  it("parses yaml frontmatter arguments and body template", () => {
    const markdown = [
      "---",
      "title: Currency Conversion",
      "description: Convert money between currencies",
      "arguments:",
      "  - name: currency",
      "    description: The target currency",
      "    required: true",
      "---",
      "",
      "Convert 100 USD to {{currency}}.",
    ].join("\n");

    const parsed = parsePromptMarkdown(markdown);

    expect(parsed.title).toBe("Currency Conversion");
    expect(parsed.description).toBe("Convert money between currencies");
    expect(parsed.arguments).toEqual([
      {
        name: "currency",
        description: "The target currency",
        required: true,
      },
    ]);
    expect(parsed.template).toBe("Convert 100 USD to {{currency}}.");
  });

  it("supports prompts without frontmatter", () => {
    const parsed = parsePromptMarkdown("Convert 100 USD to {{currency}}.");
    expect(parsed.arguments).toEqual([]);
    expect(parsed.template).toBe("Convert 100 USD to {{currency}}.");
  });

  it("rejects empty template body", () => {
    const markdown = ["---", "arguments:", "  - name: currency", "---", ""].join("\n");
    expect(() => parsePromptMarkdown(markdown)).toThrow(
      /prompt template body must be a non-empty string/,
    );
  });

  it("rejects invalid argument shape", () => {
    const markdown = ["---", "arguments:", "  - required: true", "---", "Use {{currency}}."].join(
      "\n",
    );
    expect(() => parsePromptMarkdown(markdown)).toThrow();
  });

  it("parses fixture prompt file", async () => {
    const markdown = await readFile(FIXTURE_PROMPT_PATH, "utf8");
    const parsed = parsePromptMarkdown(markdown);

    expect(parsed.title).toBe("AcmeAuth Integration Advisor");
    expect(parsed.arguments[0]?.name).toBe("app_type");
    expect(parsed.arguments[1]?.name).toBe("auth_method");
    expect(parsed.template).toContain("{{app_type}}");
    expect(parsed.template).toContain("{{auth_method}}");
  });
});
