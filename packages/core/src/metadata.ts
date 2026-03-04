import semver from "semver";
import type {
  CorpusMetadata,
  EmbeddingMetadata,
  FileMeta,
  PromptDefinition,
  TaxonomyField,
  TaxonomyValueProperties,
  ToolDescriptions,
} from "./types.js";

/**
 * Returns taxonomy keys that have `vector_collapse: true`, i.e. dimensions
 * whose values should be collapsed at search time.
 */
export function getCollapseKeys(taxonomy: Record<string, TaxonomyField>): string[] {
  return Object.entries(taxonomy)
    .filter(([, field]) => field.vector_collapse === true)
    .map(([key]) => key);
}

const LIMITS = {
  maxKeys: 64,
  maxKeyLength: 64,
  maxValuesPerKey: 512,
  maxValueLength: 128,
} as const;

export interface NormalizeMetadataOptions {
  supportedMajor?: number;
}

export function normalizeMetadata(
  input: unknown,
  options: NormalizeMetadataOptions = {},
): CorpusMetadata {
  if (!input || typeof input !== "object") {
    throw new Error("metadata must be an object");
  }

  const metadata = input as Record<string, unknown>;
  const supportedMajor = options.supportedMajor ?? 1;

  const metadataVersion = asNonEmptyString(metadata.metadata_version, "metadata_version");
  if (!semver.valid(metadataVersion)) {
    throw new Error("metadata_version must be valid semver");
  }

  const parsed = semver.parse(metadataVersion);
  if (!parsed || parsed.major !== supportedMajor) {
    throw new Error(
      `Unsupported metadata_version major: expected ${supportedMajor}.x.x, got ${metadataVersion}`,
    );
  }

  const corpusDescription = asNonEmptyString(metadata.corpus_description, "corpus_description");

  const taxonomy = normalizeTaxonomy(metadata.taxonomy);
  const stats = normalizeStats(metadata.stats);
  const embedding = normalizeEmbedding(metadata.embedding);
  const toolDescriptions = normalizeToolDescriptions(metadata.tool_descriptions);
  const mcpServerInstructions = normalizeInstructions(metadata.mcpServerInstructions);
  const files = normalizeFiles(metadata.files);
  const prompts = normalizePrompts(metadata.prompts);

  return {
    metadata_version: metadataVersion,
    corpus_description: corpusDescription,
    taxonomy,
    stats,
    embedding,
    files,
    ...(prompts.length > 0 ? { prompts } : {}),
    ...(toolDescriptions ? { tool_descriptions: toolDescriptions } : {}),
    ...(mcpServerInstructions ? { mcpServerInstructions } : {}),
  };
}

function normalizePrompts(value: unknown): PromptDefinition[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("prompts must be an array");
  }

  const names = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`prompts[${index}] must be an object`);
    }

    const prompt = entry as Record<string, unknown>;
    const name = asNonEmptyString(prompt.name, `prompts[${index}].name`);
    if (names.has(name)) {
      throw new Error(`Duplicate prompt name '${name}'`);
    }
    names.add(name);

    const args = normalizePromptArguments(prompt.arguments, index);
    const messages = normalizePromptMessages(prompt, index);
    const title =
      prompt.title === undefined
        ? undefined
        : asNonEmptyString(prompt.title, `prompts[${index}].title`);
    const description =
      prompt.description === undefined
        ? undefined
        : asNonEmptyString(prompt.description, `prompts[${index}].description`);

    return {
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      arguments: args,
      messages,
    };
  });
}

function normalizePromptMessages(
  prompt: Record<string, unknown>,
  promptIndex: number,
): PromptDefinition["messages"] {
  const hasMessages = prompt.messages !== undefined;
  const hasTemplate = prompt.template !== undefined;

  if (hasMessages && hasTemplate) {
    throw new Error(`prompts[${promptIndex}] cannot define both messages and template`);
  }

  if (hasTemplate) {
    const template = asNonEmptyString(prompt.template, `prompts[${promptIndex}].template`);
    return [
      {
        role: "user",
        content: {
          type: "text",
          text: template,
        },
      },
    ];
  }

  if (!Array.isArray(prompt.messages) || prompt.messages.length === 0) {
    throw new Error(`prompts[${promptIndex}].messages must be a non-empty array`);
  }

  return prompt.messages.map((entry, messageIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`prompts[${promptIndex}].messages[${messageIndex}] must be an object`);
    }
    const message = entry as Record<string, unknown>;

    const roleRaw = message.role;
    if (roleRaw !== "user" && roleRaw !== "assistant") {
      throw new Error(
        `prompts[${promptIndex}].messages[${messageIndex}].role must be 'user' or 'assistant'`,
      );
    }
    const role: "user" | "assistant" = roleRaw;

    if (!message.content || typeof message.content !== "object" || Array.isArray(message.content)) {
      throw new Error(
        `prompts[${promptIndex}].messages[${messageIndex}].content must be an object`,
      );
    }
    const content = message.content as Record<string, unknown>;
    if (content.type !== "text") {
      throw new Error(
        `prompts[${promptIndex}].messages[${messageIndex}].content.type must be 'text'`,
      );
    }

    return {
      role,
      content: {
        type: "text",
        text: asNonEmptyString(
          content.text,
          `prompts[${promptIndex}].messages[${messageIndex}].content.text`,
        ),
      },
    };
  });
}

function normalizePromptArguments(
  value: unknown,
  promptIndex: number,
): PromptDefinition["arguments"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`prompts[${promptIndex}].arguments must be an array`);
  }

  const names = new Set<string>();
  return value.map((entry, argIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`prompts[${promptIndex}].arguments[${argIndex}] must be an object`);
    }

    const arg = entry as Record<string, unknown>;
    const name = asNonEmptyString(arg.name, `prompts[${promptIndex}].arguments[${argIndex}].name`);
    if (names.has(name)) {
      throw new Error(`Duplicate argument name '${name}' in prompt '${promptIndex}'`);
    }
    names.add(name);

    const title =
      arg.title === undefined
        ? undefined
        : asNonEmptyString(arg.title, `prompts[${promptIndex}].arguments[${argIndex}].title`);
    const description =
      arg.description === undefined
        ? undefined
        : asNonEmptyString(
            arg.description,
            `prompts[${promptIndex}].arguments[${argIndex}].description`,
          );

    if (arg.required !== undefined && typeof arg.required !== "boolean") {
      throw new Error(`prompts[${promptIndex}].arguments[${argIndex}].required must be a boolean`);
    }

    return {
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(arg.required !== undefined ? { required: arg.required } : {}),
    };
  });
}

function normalizeTaxonomy(value: unknown): Record<string, TaxonomyField> {
  if (!value || typeof value !== "object") {
    throw new Error("taxonomy must be an object");
  }

  const raw = value as Record<string, unknown>;
  const entries = Object.entries(raw);

  if (entries.length > LIMITS.maxKeys) {
    throw new Error(`taxonomy has too many keys (max ${LIMITS.maxKeys})`);
  }

  const normalized: Record<string, TaxonomyField> = {};

  for (const [rawKey, rawField] of entries) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error("taxonomy keys cannot be empty");
    }
    if (key.length > LIMITS.maxKeyLength) {
      throw new Error(`taxonomy key '${key}' exceeds max length ${LIMITS.maxKeyLength}`);
    }

    if (!rawField || typeof rawField !== "object") {
      throw new Error(`taxonomy field '${key}' must be an object`);
    }

    const field = rawField as Record<string, unknown>;
    const values = normalizeValues(field.values, key);
    const description =
      field.description === undefined ? undefined : asTrimmedString(field.description);

    const vectorCollapse = field.vector_collapse === true ? true : undefined;
    const properties = normalizeProperties(field.properties, key);

    normalized[key] = {
      ...(description ? { description } : {}),
      values,
      ...(vectorCollapse ? { vector_collapse: true } : {}),
      ...(properties ? { properties } : {}),
    };
  }

  return normalized;
}

function normalizeValues(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`taxonomy['${key}'].values must be an array`);
  }

  if (value.length > LIMITS.maxValuesPerKey) {
    throw new Error(`taxonomy['${key}'].values exceeds max length ${LIMITS.maxValuesPerKey}`);
  }

  const deduped = new Set<string>();
  for (const raw of value) {
    const normalized = asTrimmedString(raw);
    if (!normalized) {
      throw new Error(`taxonomy['${key}'].values cannot include empty strings`);
    }
    if (normalized.length > LIMITS.maxValueLength) {
      throw new Error(
        `taxonomy['${key}'].value '${normalized}' exceeds max length ${LIMITS.maxValueLength}`,
      );
    }
    deduped.add(normalized);
  }

  return [...deduped].sort((a, b) => a.localeCompare(b));
}

function normalizeProperties(
  value: unknown,
  taxonomyKey: string,
): Record<string, TaxonomyValueProperties> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`taxonomy['${taxonomyKey}'].properties must be an object`);
  }

  const raw = value as Record<string, unknown>;
  const result: Record<string, TaxonomyValueProperties> = {};
  let hasAny = false;

  for (const [valKey, valProps] of Object.entries(raw)) {
    if (!valProps || typeof valProps !== "object") {
      throw new Error(`taxonomy['${taxonomyKey}'].properties['${valKey}'] must be an object`);
    }
    const props = valProps as Record<string, unknown>;
    if (props.mcp_resource === true) {
      result[valKey] = { mcp_resource: true };
      hasAny = true;
    }
  }

  return hasAny ? result : undefined;
}

function normalizeStats(value: unknown): CorpusMetadata["stats"] {
  if (!value || typeof value !== "object") {
    throw new Error("stats must be an object");
  }

  const stats = value as Record<string, unknown>;
  const totalChunks = asPositiveInteger(stats.total_chunks, "stats.total_chunks", true);
  const totalFiles = asPositiveInteger(stats.total_files, "stats.total_files", true);
  const indexedAt = asNonEmptyString(stats.indexed_at, "stats.indexed_at");

  const sourceCommitRaw = stats.source_commit;
  let sourceCommit: string | null | undefined;
  if (sourceCommitRaw === undefined) {
    sourceCommit = undefined;
  } else if (sourceCommitRaw === null) {
    sourceCommit = null;
  } else {
    sourceCommit = asTrimmedString(sourceCommitRaw);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
      throw new Error("stats.source_commit must be a 40-char lowercase SHA-1");
    }
  }

  const result: CorpusMetadata["stats"] = {
    total_chunks: totalChunks,
    total_files: totalFiles,
    indexed_at: indexedAt,
  };

  if (sourceCommit !== undefined) {
    result.source_commit = sourceCommit;
  }

  return result;
}

function normalizeEmbedding(value: unknown): EmbeddingMetadata | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    throw new Error("embedding must be null or an object");
  }

  const embedding = value as Record<string, unknown>;
  const provider = asNonEmptyString(embedding.provider, "embedding.provider");
  const model = asNonEmptyString(embedding.model, "embedding.model");
  const dimensions = asPositiveInteger(embedding.dimensions, "embedding.dimensions", false);

  return { provider, model, dimensions };
}

function normalizeToolDescriptions(value: unknown): ToolDescriptions | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object") {
    throw new Error("tool_descriptions must be an object");
  }

  const raw = value as Record<string, unknown>;
  const result: ToolDescriptions = {};
  let hasAny = false;

  if (raw.search_docs !== undefined) {
    result.search_docs = asNonEmptyString(raw.search_docs, "tool_descriptions.search_docs");
    hasAny = true;
  }

  if (raw.get_doc !== undefined) {
    result.get_doc = asNonEmptyString(raw.get_doc, "tool_descriptions.get_doc");
    hasAny = true;
  }

  return hasAny ? result : undefined;
}

function normalizeInstructions(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return asNonEmptyString(value, "mcpServerInstructions");
}

function normalizeFiles(value: unknown): Record<string, FileMeta> {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("files must be an object");
  }

  const raw = value as Record<string, unknown>;
  const result: Record<string, FileMeta> = {};
  let hasAny = false;

  for (const [filepath, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`files['${filepath}'] must be an object`);
    }

    const meta = entry as Record<string, unknown>;
    const fileMeta: FileMeta = {};

    if (meta.title !== undefined) {
      if (typeof meta.title !== "string") {
        throw new Error(`files['${filepath}'].title must be a string`);
      }
      const trimmed = meta.title.trim();
      if (trimmed) {
        fileMeta.title = trimmed;
      }
    }

    result[filepath] = fileMeta;
    hasAny = true;
  }

  return result;
}

function asTrimmedString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }
  return value.trim();
}

function asNonEmptyString(value: unknown, fieldName: string): string {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function asPositiveInteger(value: unknown, fieldName: string, allowZero: boolean): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }

  const min = allowZero ? 0 : 1;
  if ((value as number) < min) {
    throw new Error(`${fieldName} must be >= ${min}`);
  }

  return value as number;
}
