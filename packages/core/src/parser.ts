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

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/**
 * Parse a markdown string into an mdast AST tree.
 */
export function parseMarkdown(content: string): Root {
  return processor.parse(content);
}
