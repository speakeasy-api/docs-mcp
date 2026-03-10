import stream from "node:stream";
import {
  configure,
  getJsonLinesFormatter,
  getLogger,
  getLogLevels,
  getStreamSink,
  type LogLevel,
  type Logger,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import type { LoggingOptions, LoggerLike, ResolvedLogger } from "./types.js";

const DEFAULT_ROOT_CATEGORY = ["app"];
const DEFAULT_LOG_LEVEL = () => process.env.LOG_LEVEL ?? "info";
const DEFAULT_LOG_PRETTY = () => process.env.LOG_PRETTY === "true";

let defaultLoggingConfigured = false;
let defaultLoggingConfigKey: string | undefined;

export async function configureDefaultLogger(
  options: Pick<LoggingOptions, "pretty" | "logLevel"> = {},
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
      console: getStreamSink(
        stream.Writable.toWeb(process.stderr) as unknown as WritableStream<Uint8Array>,
        { formatter },
      ),
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
      { category: DEFAULT_ROOT_CATEGORY, lowestLevel: logLevel, sinks: ["console"] },
    ],
  });

  defaultLoggingConfigured = true;
  defaultLoggingConfigKey = configKey;
}

export async function resolveLogger(
  options: LoggingOptions = {},
  category = DEFAULT_ROOT_CATEGORY,
): Promise<ResolvedLogger> {
  if (options.logger) {
    return adaptLogger(options.logger, category);
  }

  await configureDefaultLogger(options);

  return adaptLogger(getLogger(category), []);
}

function adaptLogger(logger: LoggerLike | Logger, category: string[]): ResolvedLogger {
  const supportsChildren = typeof logger.getChild === "function";

  const format = (message: string, properties?: Record<string, unknown>) => {
    const prefix = !supportsChildren && category.length > 0 ? `[${category.join(".")}] ` : "";
    return {
      message: prefix + message,
      properties,
    };
  };

  return {
    debug(message: string, properties?: Record<string, unknown>) {
      const entry = format(message, properties);
      if (entry.properties === undefined) {
        logger.debug(entry.message);
        return;
      }
      logger.debug(entry.message, entry.properties);
    },
    info(message: string, properties?: Record<string, unknown>) {
      const entry = format(message, properties);
      if (entry.properties === undefined) {
        logger.info(entry.message);
        return;
      }
      logger.info(entry.message, entry.properties);
    },
    warn(message: string, properties?: Record<string, unknown>) {
      const entry = format(message, properties);
      if (entry.properties === undefined) {
        logger.warn(entry.message);
        return;
      }
      logger.warn(entry.message, entry.properties);
    },
    error(message: string, properties?: Record<string, unknown>) {
      const entry = format(message, properties);
      if (entry.properties === undefined) {
        logger.error(entry.message);
        return;
      }
      logger.error(entry.message, entry.properties);
    },
    getChild(name: string) {
      if (supportsChildren) {
        return adaptLogger(logger.getChild!(name), []);
      }

      return adaptLogger(logger, [...category, name]);
    },
  };
}
