import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePromptMarkdown, parsePromptTemplateYaml } from "../prompt.js";

const FIXTURE_PROMPT_PATH = path.resolve(
  import.meta.dirname,
  "../../../../tests/fixtures/docs/guides/auth-integration.template.md",
);
const FIXTURE_PROMPT_YAML_PATH = path.resolve(
  import.meta.dirname,
  "../../../../tests/fixtures/docs/guides/auth-integration.template.yaml",
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
    expect(parsed.messages).toEqual([
      {
        role: "user",
        content: {
          type: "text",
          text: "Convert 100 USD to {{currency}}.",
        },
      },
    ]);
  });

  it("supports prompts without frontmatter", () => {
    const parsed = parsePromptMarkdown("Convert 100 USD to {{currency}}.");
    expect(parsed.arguments).toEqual([]);
    expect(parsed.messages[0]?.content.text).toBe("Convert 100 USD to {{currency}}.");
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

  it("parses yaml template with multiple messages", () => {
    const parsed = parsePromptTemplateYaml(
      [
        "title: Multi Message Prompt",
        "arguments:",
        "  - name: app_type",
        "    required: true",
        "messages:",
        "  - role: user",
        "    content:",
        "      type: text",
        "      text: Build a plan for {{app_type}}.",
        "  - role: assistant",
        "    content:",
        "      type: text",
        "      text: I will produce phased guidance.",
      ].join("\n"),
    );

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1]?.role).toBe("assistant");
  });

  it("parses fixture prompt file", async () => {
    const markdown = await readFile(FIXTURE_PROMPT_PATH, "utf8");
    const parsed = parsePromptMarkdown(markdown);

    expect(parsed.title).toBe("AcmeAuth Integration Advisor");
    expect(parsed.arguments[0]?.name).toBe("app_type");
    expect(parsed.arguments[1]?.name).toBe("auth_method");
    expect(parsed.messages[0]?.content.text).toContain("{{app_type}}");
    expect(parsed.messages[0]?.content.text).toContain("{{auth_method}}");
  });

  it("parses fixture yaml prompt file", async () => {
    const yamlText = await readFile(FIXTURE_PROMPT_YAML_PATH, "utf8");
    const parsed = parsePromptTemplateYaml(yamlText);

    expect(parsed.title).toContain("YAML");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1]?.role).toBe("assistant");
  });
});
