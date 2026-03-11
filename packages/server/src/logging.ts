import {
  configure,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  getLogLevels,
  type LogLevel,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import type { CreateDocsServerRuntimeOptions, Logger } from "./types.js";

const DEFAULT_LOG_LEVEL = () => process.env.LOG_LEVEL ?? "info";
const DEFAULT_LOG_PRETTY = () => process.env.LOG_PRETTY === "true";

let defaultLoggingConfigured = false;
let defaultLoggingConfigKey: string | undefined;

export async function configureDefaultLogger(
  options: Pick<CreateDocsServerRuntimeOptions, "pretty" | "logLevel"> = {},
): Promise<void> {
  const logLevel = (getLogLevels().find((level) => level === options.logLevel) ??
    getLogLevels().find((level) => level === DEFAULT_LOG_LEVEL()) ??
    "info") as LogLevel;
  const pretty = options.pretty ?? DEFAULT_LOG_PRETTY();
  const configKey = `${logLevel}:${pretty ? "pretty" : "jsonl"}`;

  if (defaultLoggingConfigured && defaultLoggingConfigKey === configKey) {
    return;
  }

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
      console: getConsoleSink({ formatter }),
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
      { category: ["app"], lowestLevel: logLevel, sinks: ["console"] },
    ],
  });

  defaultLoggingConfigured = true;
  defaultLoggingConfigKey = configKey;
}

export async function resolveLogger(options: CreateDocsServerRuntimeOptions = {}): Promise<Logger> {
  if (options.logger) {
    return options.logger;
  }

  await configureDefaultLogger(options);

  return getLogger(["app"]);
}
