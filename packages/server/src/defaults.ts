import { createRequire } from "node:module";
import type { BuildInfo } from "./types.js";

const require = createRequire(import.meta.url);

export const PACKAGE_SERVER_NAME = "@speakeasy-api/docs-mcp-server";
export const PACKAGE_SERVER_VERSION = readPackageVersion();

export function resolveServerName(serverName?: string, toolPrefix?: string): string {
  if (serverName) {
    return serverName;
  }

  if (process.env["SERVER_NAME"]) {
    return process.env["SERVER_NAME"];
  }

  return toolPrefix ? `${toolPrefix}-docs-server` : PACKAGE_SERVER_NAME;
}

export function resolveServerVersion(serverVersion?: string): string {
  return serverVersion ?? process.env["SERVER_VERSION"] ?? PACKAGE_SERVER_VERSION;
}

export function resolveBuildInfo(input: {
  name: string;
  version: string;
  gitCommit?: string;
  buildDate?: string;
}): BuildInfo {
  return {
    name: input.name,
    version: input.version,
    gitCommit: input.gitCommit ?? process.env["GIT_COMMIT"],
    buildDate: input.buildDate ?? process.env["BUILD_DATE"],
  };
}

function readPackageVersion(): string {
  const pkg = require("../package.json");
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}
