import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Chunk } from "@speakeasy-api/docs-mcp-core";
import fg from "fast-glob";

type RegistrySymbol = {
  id: string;
  name: string;
  sdkImport?: string;
  uses?: string[];
};

type RegistryFile = {
  symbols?: RegistrySymbol[];
};

type MethodRegistryIndex = Map<string, RegistrySymbol>;

type ChunkKind = "entrypoint" | "method" | "type";

type AnnotatedDecl = {
  kind: ChunkKind;
  name: string;
  owner?: string | undefined;
  comment: string;
  block: string;
  signatureLine?: string | undefined;
};

export async function buildLlmsGoChunks(llmsDir: string): Promise<Chunk[]> {
  const registryPath = path.join(llmsDir, "registry.json");
  const registrySource = await readFile(registryPath, "utf8");
  const registry = parseRegistry(registrySource);
  const methodIndex = buildMethodRegistryIndex(registry.symbols ?? []);
  const rootModulePath = inferRootModulePath(registry.symbols ?? []);

  const files = await fg(["**/*.go"], {
    cwd: llmsDir,
    absolute: true,
    onlyFiles: true
  });
  files.sort((a, b) => a.localeCompare(b));

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  const typeChunksByOwner = new Map<string, Chunk>();

  for (const absoluteFile of files) {
    const relativePath = toPosix(path.join("llms", path.relative(llmsDir, absoluteFile)));
    const source = await readFile(absoluteFile, "utf8");
    const sdkImport = toSdkImportFromLlmsFile(relativePath, rootModulePath);
    const declarations = parseAnnotatedDeclarations(source);

    for (const decl of declarations) {
      if (decl.kind === "type" && decl.owner) {
        const ownerKey = `${relativePath}:${decl.owner}`;
        const parentChunk = typeChunksByOwner.get(ownerKey);
        if (parentChunk) {
          appendReceiverMethod(parentChunk, decl);
          continue;
        }
      }

      const chunk = buildChunk(decl, relativePath, chunkIndex, sdkImport, methodIndex);
      if (chunk) {
        chunks.push(chunk);
        if (decl.kind === "type" && !decl.owner) {
          typeChunksByOwner.set(`${relativePath}:${decl.name}`, chunk);
        }
        chunkIndex += 1;
      }
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Chunk builders
// ---------------------------------------------------------------------------

function buildChunk(
  decl: AnnotatedDecl,
  filepath: string,
  chunkIndex: number,
  sdkImport: string,
  methodIndex: MethodRegistryIndex
): Chunk | null {
  switch (decl.kind) {
    case "entrypoint":
      return buildEntrypointChunk(decl, filepath, chunkIndex);
    case "method":
      return buildMethodChunk(decl, filepath, chunkIndex, methodIndex);
    case "type":
      return buildTypeChunk(decl, filepath, chunkIndex, sdkImport);
    default:
      return null;
  }
}

function buildEntrypointChunk(decl: AnnotatedDecl, filepath: string, chunkIndex: number): Chunk {
  const heading = decl.name;
  const parts: string[] = [`## ${heading}`, ""];
  if (decl.comment) {
    parts.push(decl.comment, "");
  }
  parts.push("```go", decl.block, "```");
  const content = parts.join("\n");

  return {
    chunk_id: `${filepath}#entrypoint-${slug(decl.name)}`,
    filepath,
    heading,
    heading_level: 2,
    content,
    content_text: content,
    breadcrumb: `${filepath} > ${heading}`,
    chunk_index: chunkIndex,
    metadata: {
      source: "llms-go",
      kind: "entrypoint",
      entrypoint: "true"
    }
  };
}

function buildMethodChunk(
  decl: AnnotatedDecl,
  filepath: string,
  chunkIndex: number,
  methodIndex: MethodRegistryIndex
): Chunk {
  const owner = decl.owner ?? "Unknown";
  const heading = `${owner}.${decl.name}`;
  const symbolID = `method:${owner}.${decl.name}`;
  const registry = methodIndex.get(`${owner}.${decl.name}`);
  const registryUses = registry?.uses ?? [];
  const registryID = registry?.id ?? "";

  const usesText = registryUses.length > 0
    ? registryUses.map((use) => `- ${use}`).join("\n")
    : "- (none)";

  const content = [
    `## ${heading}`,
    "",
    decl.comment || "",
    decl.comment ? "" : "",
    "```go",
    decl.signatureLine ?? decl.block,
    "```",
    "",
    `Symbol ID: ${symbolID}`,
    registryID ? `Registry Method ID: ${registryID}` : "Registry Method ID: (not found)",
    "",
    "Uses:",
    usesText
  ].join("\n").trim();

  return {
    chunk_id: `${filepath}#method-${slug(owner)}-${slug(decl.name)}`,
    filepath,
    heading,
    heading_level: 2,
    content,
    content_text: content,
    breadcrumb: `${filepath} > ${owner} > ${decl.name}`,
    chunk_index: chunkIndex,
    metadata: {
      source: "llms-go",
      kind: "method",
      owner,
      method: decl.name,
      symbol_id: symbolID,
      sdk_symbol: decl.name,
      entrypoint: "false"
    }
  };
}

function buildTypeChunk(
  decl: AnnotatedDecl,
  filepath: string,
  chunkIndex: number,
  sdkImport: string
): Chunk {
  const symbolId = `type:${sdkImport}.${decl.name}`;
  const parts: string[] = [`## ${decl.name}`, ""];
  if (decl.comment) {
    parts.push(decl.comment, "");
  }
  parts.push("```go", decl.block, "```");
  const content = parts.join("\n");

  return {
    chunk_id: `${filepath}#type-${slug(decl.name)}`,
    filepath,
    heading: decl.name,
    heading_level: 2,
    content,
    content_text: content,
    breadcrumb: `${filepath} > ${decl.name}`,
    chunk_index: chunkIndex,
    metadata: {
      source: "llms-go",
      kind: "type",
      symbol_id: symbolId,
      sdk_import: sdkImport,
      sdk_symbol: decl.name,
      entrypoint: "false"
    }
  };
}

function appendReceiverMethod(parentChunk: Chunk, decl: AnnotatedDecl): void {
  const methodBlock = [
    "",
    decl.comment || "",
    decl.comment ? "" : "",
    "```go",
    decl.signatureLine ?? decl.block,
    "```"
  ].join("\n").trimEnd();

  parentChunk.content += methodBlock;
  parentChunk.content_text += methodBlock;
}

// ---------------------------------------------------------------------------
// Annotation-driven Go source parser
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<ChunkKind>(["entrypoint", "method", "type"]);

export function parseAnnotatedDeclarations(source: string): AnnotatedDecl[] {
  const lines = source.split("\n");
  const results: AnnotatedDecl[] = [];
  let depth = 0;
  let pendingComments: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (depth > 0) {
      depth += countChar(line, "{") - countChar(line, "}");
      continue;
    }

    if (trimmed.startsWith("//")) {
      pendingComments.push(trimmed);
      continue;
    }

    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    const kindResult = extractKindAnnotation(pendingComments);
    if (!kindResult) {
      depth += countChar(line, "{") - countChar(line, "}");
      skipGroupedBlock(lines, i, trimmed, (newI) => { i = newI; });
      pendingComments = [];
      continue;
    }

    const parsed = parseDeclarationAt(lines, i, kindResult.kind, kindResult.cleanedComments);
    if (parsed) {
      results.push(parsed.decl);
      i = parsed.endLine;
      depth = 0;
    } else {
      depth += countChar(line, "{") - countChar(line, "}");
    }

    pendingComments = [];
  }

  return results;
}

function extractKindAnnotation(
  comments: string[]
): { kind: ChunkKind; cleanedComments: string[] } | null {
  let foundKind: ChunkKind | null = null;
  let kindLineIndex = -1;
  let residualComment: string | null = null;

  for (let i = 0; i < comments.length; i += 1) {
    const match = comments[i]?.match(/^\/\/\s*kind:\s*(\w+)(.*)/);
    if (match && VALID_KINDS.has(match[1] as ChunkKind)) {
      foundKind = match[1] as ChunkKind;
      kindLineIndex = i;
      const rest = (match[2] ?? "").trim();
      if (rest.startsWith("//")) {
        residualComment = rest;
      } else if (rest) {
        residualComment = `// ${rest}`;
      } else {
        residualComment = null;
      }
    }
  }

  if (foundKind === null || kindLineIndex < 0) {
    return null;
  }

  const cleanedComments = comments.filter((_, idx) => idx !== kindLineIndex);
  if (residualComment) {
    cleanedComments.splice(kindLineIndex, 0, residualComment);
  }

  return { kind: foundKind, cleanedComments };
}

function parseDeclarationAt(
  lines: string[],
  startLine: number,
  kind: ChunkKind,
  cleanedComments: string[]
): { decl: AnnotatedDecl; endLine: number } | null {
  const line = lines[startLine] ?? "";
  const trimmed = line.trim();

  let name: string | null = null;
  let owner: string | undefined;
  let signatureLine: string | undefined;

  const receiverMatch = trimmed.match(
    /^func\s+\(\s*\w+\s+\*?([A-Za-z0-9_]+)(?:\[[^\]]*\])?\s*\)\s+([A-Za-z0-9_]+)\(/
  );
  if (receiverMatch) {
    owner = receiverMatch[1]!;
    name = receiverMatch[2]!;
    signatureLine = trimmed;
  }

  if (!name) {
    const funcMatch = trimmed.match(/^func\s+([A-Za-z0-9_]+)\(/);
    if (funcMatch) {
      name = funcMatch[1]!;
      signatureLine = trimmed;
    }
  }

  if (!name) {
    const typeMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (typeMatch && !/^type\s*\($/.test(trimmed)) {
      name = typeMatch[1]!;
    }
  }

  if (!name) {
    const constVarMatch = trimmed.match(/^(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (constVarMatch) {
      name = constVarMatch[1]!;
    }
  }

  if (!name) {
    const groupMatch = /^(?:const|var)\s*\(/.test(trimmed);
    if (groupMatch) {
      name = inferConstGroupName(lines, startLine);
    }
  }

  if (!name) {
    return null;
  }

  const endLine = findBlockEnd(lines, startLine, trimmed);
  const block = lines.slice(startLine, endLine + 1).join("\n").trim();
  const comment = cleanedComments.join("\n");

  return {
    decl: { kind, name, owner, comment, block, signatureLine },
    endLine
  };
}

function findBlockEnd(lines: string[], startLine: number, trimmed: string): number {
  const line = lines[startLine] ?? "";
  const braceDepth = countChar(line, "{") - countChar(line, "}");
  if (braceDepth > 0) {
    let d = braceDepth;
    for (let j = startLine + 1; j < lines.length; j += 1) {
      d += countChar(lines[j] ?? "", "{") - countChar(lines[j] ?? "", "}");
      if (d <= 0) {
        return j;
      }
    }
    return lines.length - 1;
  }

  const isGrouped = /^(?:const|var)\s*\(/.test(trimmed);
  if (isGrouped) {
    let d = countChar(line, "(") - countChar(line, ")");
    for (let j = startLine + 1; j < lines.length; j += 1) {
      d += countChar(lines[j] ?? "", "(") - countChar(lines[j] ?? "", ")");
      if (d <= 0) {
        return j;
      }
    }
    return lines.length - 1;
  }

  return startLine;
}

function inferConstGroupName(lines: string[], startLine: number): string {
  for (let j = startLine + 1; j < lines.length; j += 1) {
    const entry = (lines[j] ?? "").trim();
    if (entry === ")" || entry === "") {
      continue;
    }
    const typedMatch = entry.match(/^\w+\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (typedMatch?.[1]) {
      return typedMatch[1];
    }
    const untypedMatch = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[\s=]/);
    if (untypedMatch?.[1]) {
      return untypedMatch[1];
    }
    break;
  }
  return "constants";
}

/**
 * Skips past grouped const/var blocks for unannotated declarations so the
 * outer loop's depth tracking stays correct.
 */
function skipGroupedBlock(
  lines: string[],
  startLine: number,
  trimmed: string,
  setI: (newI: number) => void
): void {
  if (/^(?:const|var)\s*\(/.test(trimmed)) {
    const line = lines[startLine] ?? "";
    let d = countChar(line, "(") - countChar(line, ")");
    for (let j = startLine + 1; j < lines.length && d > 0; j += 1) {
      d += countChar(lines[j] ?? "", "(") - countChar(lines[j] ?? "", ")");
      if (d <= 0) {
        setI(j);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function parseRegistry(source: string): RegistryFile {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as RegistryFile;
}

function buildMethodRegistryIndex(symbols: RegistrySymbol[]): MethodRegistryIndex {
  const index: MethodRegistryIndex = new Map();
  for (const symbol of symbols) {
    if (!symbol.id.startsWith("method:")) {
      continue;
    }
    const methodRef = parseMethodRefFromRegistryID(symbol.id);
    if (!methodRef) {
      continue;
    }
    index.set(`${methodRef.owner}.${methodRef.method}`, symbol);
  }
  return index;
}

function parseMethodRefFromRegistryID(id: string): { owner: string; method: string } | null {
  const match = id.match(/^method:[^:]+\.\(\*([^)]+)\)\.([A-Za-z0-9_]+)$/);
  if (!match) {
    return null;
  }
  const owner = match[1];
  const method = match[2];
  if (!owner || !method) {
    return null;
  }
  return { owner, method };
}

function inferRootModulePath(symbols: RegistrySymbol[]): string {
  for (const symbol of symbols) {
    if (symbol.sdkImport && symbol.id.startsWith("method:")) {
      return symbol.sdkImport;
    }
  }
  for (const symbol of symbols) {
    if (symbol.id.startsWith("type:")) {
      const match = symbol.id.match(/^type:(.+)\.[^.]+$/);
      if (match?.[1]) {
        return match[1].split("/")[0]!;
      }
    }
  }
  return "unknown.module";
}

function toSdkImportFromLlmsFile(filepath: string, rootModulePath: string): string {
  const normalized = toPosix(filepath);
  if (!normalized.startsWith("llms/")) {
    return rootModulePath;
  }
  const withoutPrefix = normalized.slice("llms/".length);
  const dir = withoutPrefix.split("/").slice(0, -1).join("/");
  if (!dir || dir === ".") {
    return rootModulePath;
  }
  return `${rootModulePath}/${dir}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const c of value) {
    if (c === char) {
      count += 1;
    }
  }
  return count;
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
