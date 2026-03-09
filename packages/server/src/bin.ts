#!/usr/bin/env node

import { createRequire } from "node:module";
import stream from "node:stream";
import { Command } from "commander";
import {
  configure,
  getJsonLinesFormatter,
  getLogger,
  getLogLevels,
  getStreamSink,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";

import { startStdioServer } from "./stdio.js";
import { startHttpServer } from "./http.js";
import { createDocsMcpServerFactory } from "./create.js";
import { BuildInfo } from "./types.js";

const require = createRequire(import.meta.url);
const SERVER_VERSION = readPackageVersion();

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
  .option(
    "--name <value>",
    "MCP server name (env: SERVER_NAME)",
    process.env["SERVER_NAME"] || "@speakeasy-api/docs-mcp-server",
  )
  .option("--tool-prefix <value>", "Tool name prefix (e.g. 'acme' produces acme_search_docs)")
  .option(
    "--version <value>",
    "MCP server version (env: SERVER_VERSION)",
    process.env["SERVER_VERSION"] || SERVER_VERSION,
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
    await configureLogging({
      pretty: options.logPretty,
      logLevel: options.logLevel,
    });

    const serverName =
      options.name === "@speakeasy-api/docs-mcp-server" && options.toolPrefix
        ? `${options.toolPrefix}-docs-server`
        : options.name;
    const buildInfo: BuildInfo = {
      name: serverName,
      version: options.version,
      gitCommit: options.gitCommit,
      buildDate: options.buildDate,
    };

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

    const mcpServerFactory = await createDocsMcpServerFactory(getLogger(["app"]), {
      serverName,
      serverVersion: options.version,
      indexDir: options.indexDir,
      toolPrefix: options.toolPrefix,
      queryEmbeddingApiKey: options.queryEmbeddingApiKey,
      queryEmbeddingBaseUrl: options.queryEmbeddingBaseUrl,
      queryEmbeddingBatchSize: options.queryEmbeddingBatchSize,
      proximityWeight: options.proximityWeight,
      phraseSlop: options.phraseSlop,
      vectorWeight: options.vectorWeight,
      ...(customTools.length > 0 ? { customTools } : {}),
    });

    if (options.transport === "http") {
      await startHttpServer(mcpServerFactory, {
        logger: getLogger(["app", "http"]),
        buildInfo,
        port: options.port,
      });
    } else {
      await startStdioServer(mcpServerFactory);
    }
  });

function readPackageVersion(): string {
  const pkg = require("../package.json");
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}

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

async function configureLogging(options: { pretty: boolean; logLevel: string }) {
  const { pretty, logLevel } = options;
  const lowestLevel = getLogLevels().find((l) => l === logLevel) || "info";

  const formatter = pretty
    ? getPrettyFormatter({
        colors: true,
        icons: true,
        properties: true,
        timestampStyle: null,
        levelStyle: ["bold"],
        categoryStyle: ["italic"],
        messageStyle: null,
      })
    : getJsonLinesFormatter();

  await configure({
    sinks: {
      console: getStreamSink(stream.Writable.toWeb(process.stderr), { formatter }),
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
      { category: ["app"], lowestLevel, sinks: ["console"] },
    ],
  });
}
