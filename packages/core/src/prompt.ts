import matter from "gray-matter";
import { z } from "zod";
import type { RootContent } from "mdast";
import type { PromptArgument, PromptMessage } from "./types.js";
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
  messages: PromptMessage[];
}

export interface ParsedPromptYaml {
  title?: string;
  description?: string;
  arguments: PromptArgument[];
  messages: PromptMessage[];
}

const PromptTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1, "messages[].content.text must be a non-empty string"),
});

const PromptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: PromptTextContentSchema,
});

const PromptYamlSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  arguments: z.array(PromptArgumentSchema).optional(),
  messages: z.array(PromptMessageSchema).min(1, "messages must include at least one message"),
});

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
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: normalizedBody,
        },
      },
    ],
  };
}

export function parsePromptTemplateYaml(yamlText: string): ParsedPromptYaml {
  const parsed = parseYamlObject(yamlText, "prompt template yaml must be an object");
  const normalized = PromptYamlSchema.parse(parsed);

  return {
    ...(normalized.title ? { title: normalized.title } : {}),
    ...(normalized.description ? { description: normalized.description } : {}),
    arguments: (normalized.arguments ?? []).map((argument) => ({
      name: argument.name,
      ...(argument.title ? { title: argument.title } : {}),
      ...(argument.description ? { description: argument.description } : {}),
      ...(argument.required !== undefined ? { required: argument.required } : {}),
    })),
    messages: normalized.messages.map((message) => ({
      role: message.role,
      content: {
        type: "text",
        text: message.content.text,
      },
    })),
  };
}

function parseFrontmatter(rawFrontmatter: string): Record<string, unknown> {
  if (!rawFrontmatter.trim()) {
    return {};
  }

  return parseYamlObject(rawFrontmatter, "prompt frontmatter must be an object");
}

function parseYamlObject(rawYaml: string, errorMessage: string): Record<string, unknown> {
  const parsed = matter(`---\n${rawYaml}\n---\n`);
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    throw new Error(errorMessage);
  }

  return parsed.data as Record<string, unknown>;
}
