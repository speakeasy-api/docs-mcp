import matter from "gray-matter";
import { z } from "zod";
import type { RootContent } from "mdast";
import type { PromptArgument } from "./types.js";
import { parseMarkdown } from "./parser.js";

const PromptArgumentSchema = z.object({
  name: z.string().trim().min(1, "arguments[].name must be a non-empty string"),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  required: z.boolean().optional(),
});

const PromptFrontmatterSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  arguments: z.array(PromptArgumentSchema).optional(),
});

export interface ParsedPromptMarkdown {
  title?: string;
  description?: string;
  arguments: PromptArgument[];
  template: string;
}

export function parsePromptMarkdown(markdown: string): ParsedPromptMarkdown {
  const ast = parseMarkdown(markdown);
  const firstNode = ast.children[0] as RootContent | undefined;

  let frontmatter = "";
  let body = markdown;

  if (firstNode?.type === "yaml") {
    frontmatter = firstNode.value;
    const bodyOffset = firstNode.position?.end.offset;
    body = bodyOffset !== undefined ? markdown.slice(bodyOffset) : "";
  }

  const normalizedBody = body.trim();
  if (!normalizedBody) {
    throw new Error("prompt template body must be a non-empty string");
  }

  const frontmatterRecord = parseFrontmatter(frontmatter);
  const parsedFrontmatter = PromptFrontmatterSchema.parse(frontmatterRecord);

  return {
    ...(parsedFrontmatter.title ? { title: parsedFrontmatter.title } : {}),
    ...(parsedFrontmatter.description ? { description: parsedFrontmatter.description } : {}),
    arguments: (parsedFrontmatter.arguments ?? []).map((argument) => ({
      name: argument.name,
      ...(argument.title ? { title: argument.title } : {}),
      ...(argument.description ? { description: argument.description } : {}),
      ...(argument.required !== undefined ? { required: argument.required } : {}),
    })),
    template: normalizedBody,
  };
}

function parseFrontmatter(rawFrontmatter: string): Record<string, unknown> {
  if (!rawFrontmatter.trim()) {
    return {};
  }

  const parsed = matter(`---\n${rawFrontmatter}\n---\n`);
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    throw new Error("prompt frontmatter must be an object");
  }

  return parsed.data as Record<string, unknown>;
}
