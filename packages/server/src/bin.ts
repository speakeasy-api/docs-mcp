#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { createDocsServer } from "./create.js";
import { startStdioServer } from "./stdio.js";
import { startHttpServer } from "./http.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as {
  version: string;
};

interface ServerCliOptions {
  indexDir: string;
  name: string;
  toolPrefix?: string;
  version: string;
  queryEmbeddingApiKey?: string;
  queryEmbeddingBaseUrl?: string;
  queryEmbeddingBatchSize?: number;
  proximityWeight?: number;
  phraseSlop?: number;
  vectorWeight?: number;
  transport: "stdio" | "http";
  port: number;
}

const program = new Command();

program
  .name("docs-mcp-server")
  .description("Run @speakeasy-api/docs-mcp-server over MCP stdio transport")
  .requiredOption("--index-dir <path>", "Directory containing chunks.json and metadata.json")
  .option("--name <value>", "MCP server name", "@speakeasy-api/docs-mcp-server")
  .option("--tool-prefix <value>", "Tool name prefix (e.g. 'acme' produces acme_search_docs)")
  .option("--version <value>", "MCP server version", SERVER_VERSION)
  .option("--query-embedding-api-key <value>", "Query embedding API key (or set OPENAI_API_KEY)")
  .option("--query-embedding-base-url <value>", "Query embedding API base URL")
  .option("--query-embedding-batch-size <number>", "Query embedding batch size", parseIntOption)
  .option("--proximity-weight <number>", "Lexical phrase blend weight", parseNumberOption)
  .option("--phrase-slop <number>", "Phrase query slop (0-5)", parseNumberOption)
  .option("--vector-weight <number>", "Vector rank blend weight", parseNumberOption)
  .option("--transport <type>", "Transport type: stdio or http", "stdio")
  .option(
    "--port <number>",
    "HTTP server port (only used with --transport http)",
    parseIntOption,
    20310,
  )
  .action(async (options: ServerCliOptions) => {
    const app = await createDocsServer({
      indexDir: options.indexDir,
      toolPrefix: options.toolPrefix,
      queryEmbeddingApiKey: options.queryEmbeddingApiKey,
      queryEmbeddingBaseUrl: options.queryEmbeddingBaseUrl,
      queryEmbeddingBatchSize: options.queryEmbeddingBatchSize,
      proximityWeight: options.proximityWeight,
      phraseSlop: options.phraseSlop,
      vectorWeight: options.vectorWeight,
    });

    const serverName =
      options.name === "@speakeasy-api/docs-mcp-server" && options.toolPrefix
        ? `${options.toolPrefix}-docs-server`
        : options.name;

    if (options.transport === "http") {
      await startHttpServer(app, {
        name: serverName,
        version: options.version,
        port: options.port,
      });
    } else {
      await startStdioServer(app, {
        name: serverName,
        version: options.version,
      });
    }
  });

void program.parseAsync(process.argv);

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric value '${value}'`);
  }
  return parsed;
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid integer value '${value}'`);
  }
  return parsed;
}
