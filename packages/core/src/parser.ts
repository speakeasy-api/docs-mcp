/**
 * Markdown AST parser using unified + remark-parse + remark-frontmatter + remark-gfm.
 *
 * Supports YAML frontmatter and GitHub Flavored Markdown extensions
 * (tables, task lists, strikethrough, autolinks).
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/**
 * Parse a markdown string into an mdast AST tree.
 */
export function parseMarkdown(content: string): Root {
  return processor.parse(content);
}

/**
 * Extract the text content of the first H1 heading from a markdown string.
 * Returns undefined if no H1 heading is found or it is empty.
 */
export function extractFirstH1(markdown: string): string | undefined {
  const ast = processor.parse(markdown);
  for (const node of ast.children) {
    if (node.type === "heading" && node.depth === 1) {
      const text = toString(node).trim();
      return text || undefined;
    }
  }
  return undefined;
}
