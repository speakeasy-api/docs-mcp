#!/usr/bin/env node

import { Command } from "commander";

import { startStdioServer } from "./stdio.js";
import { startHttpServer } from "./http.js";
import { createDocsServer } from "./create.js";

interface ServerCliOptions {
  indexDir: string;
  name?: string;
  toolPrefix?: string;
  version?: string;
  queryEmbeddingApiKey?: string;
  queryEmbeddingBaseUrl?: string;
  queryEmbeddingBatchSize?: number;
  proximityWeight?: number;
  phraseSlop?: number;
  vectorWeight?: number;
  transport: "stdio" | "http";
  port: number;
  customToolsJson?: string;
  gitCommit?: string;
  buildDate?: string;
  logPretty: boolean;
  logLevel: string;
}

const program = new Command();

program
  .name("docs-mcp-server")
  .description("Run @speakeasy-api/docs-mcp-server")
  .requiredOption("--index-dir <path>", "Directory containing chunks.json and metadata.json")
  .option("--name <value>", "MCP server name (env: SERVER_NAME)", process.env["SERVER_NAME"])
  .option("--tool-prefix <value>", "Tool name prefix (e.g. 'acme' produces acme_search_docs)")
  .option(
    "--version <value>",
    "MCP server version (env: SERVER_VERSION)",
    process.env["SERVER_VERSION"],
  )
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
  .option(
    "--custom-tools-json <json>",
    "JSON array of custom tool definitions [{name, description, inputSchema}], each registered with an echo handler",
  )
  .option(
    "--git-commit <value>",
    "Git commit SHA to include in server info (env: GIT_COMMIT)",
    process.env["GIT_COMMIT"],
  )
  .option(
    "--build-date <value>",
    "Build date to include in server info (env: BUILD_DATE)",
    process.env["BUILD_DATE"],
  )
  .option(
    "--log-pretty",
    "Enable pretty logging output (env: LOG_PRETTY)",
    (v) => v === "true",
    process.env["LOG_PRETTY"] && process.env["LOG_PRETTY"] === "true",
  )
  .option(
    "--log-level",
    "Logging level (debug, info, warn, error)",
    process.env["LOG_LEVEL"] || "info",
  )
  .action(async (options: ServerCliOptions) => {
    const customTools = options.customToolsJson
      ? (
          JSON.parse(options.customToolsJson) as Array<{
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>
        ).map((def) => ({
          ...def,
          handler: async (args: unknown) => ({
            content: [{ type: "text" as const, text: JSON.stringify(args) }],
            isError: false,
          }),
        }))
      : [];

    const server = await createDocsServer(
      {
        ...(options.name ? { serverName: options.name } : {}),
        ...(options.version ? { serverVersion: options.version } : {}),
        indexDir: options.indexDir,
        toolPrefix: options.toolPrefix,
        queryEmbeddingApiKey: options.queryEmbeddingApiKey,
        queryEmbeddingBaseUrl: options.queryEmbeddingBaseUrl,
        queryEmbeddingBatchSize: options.queryEmbeddingBatchSize,
        proximityWeight: options.proximityWeight,
        phraseSlop: options.phraseSlop,
        vectorWeight: options.vectorWeight,
        ...(customTools.length > 0 ? { customTools } : {}),
      },
      {
        pretty: options.logPretty,
        logLevel: options.logLevel,
      },
    );

    if (options.transport === "http") {
      const { shutdown } = await startHttpServer(server, {
        port: options.port,
        ...(options.gitCommit || options.buildDate
          ? {
              buildInfo: {
                ...server.buildInfo,
                ...(options.gitCommit ? { gitCommit: options.gitCommit } : {}),
                ...(options.buildDate ? { buildDate: options.buildDate } : {}),
              },
            }
          : {}),
        pretty: options.logPretty,
        logLevel: options.logLevel,
      });
      registerShutdown(shutdown);
    } else {
      const { shutdown } = await startStdioServer(server);
      registerShutdown(shutdown);
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

function registerShutdown(cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await cleanup();
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`Failed to shut down on ${signal}: ${message}\n`);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}
