import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_SERVER_NAME,
  PACKAGE_SERVER_VERSION,
  resolveBuildInfo,
  resolveServerName,
  resolveServerVersion,
} from "../defaults.js";

const ORIGINAL_ENV = {
  SERVER_NAME: process.env.SERVER_NAME,
  SERVER_VERSION: process.env.SERVER_VERSION,
  GIT_COMMIT: process.env.GIT_COMMIT,
  BUILD_DATE: process.env.BUILD_DATE,
};

afterEach(() => {
  process.env.SERVER_NAME = ORIGINAL_ENV.SERVER_NAME;
  process.env.SERVER_VERSION = ORIGINAL_ENV.SERVER_VERSION;
  process.env.GIT_COMMIT = ORIGINAL_ENV.GIT_COMMIT;
  process.env.BUILD_DATE = ORIGINAL_ENV.BUILD_DATE;
});

describe("defaults", () => {
  it("treats blank env values as unset", () => {
    process.env.SERVER_NAME = "   ";
    process.env.SERVER_VERSION = "";
    process.env.GIT_COMMIT = " ";
    process.env.BUILD_DATE = "\t";

    expect(resolveServerName(undefined, "cisco")).toBe("cisco-docs-server");
    expect(resolveServerVersion()).toBe(PACKAGE_SERVER_VERSION);
    expect(
      resolveBuildInfo({ name: PACKAGE_SERVER_NAME, version: PACKAGE_SERVER_VERSION }),
    ).toEqual({
      name: PACKAGE_SERVER_NAME,
      version: PACKAGE_SERVER_VERSION,
    });
  });

  it("prefers non-empty env values", () => {
    process.env.SERVER_NAME = "demo-docs";
    process.env.SERVER_VERSION = "1.2.3";
    process.env.GIT_COMMIT = "abc123";
    process.env.BUILD_DATE = "2026-03-10T00:00:00Z";

    expect(resolveServerName()).toBe("demo-docs");
    expect(resolveServerVersion()).toBe("1.2.3");
    expect(
      resolveBuildInfo({ name: PACKAGE_SERVER_NAME, version: PACKAGE_SERVER_VERSION }),
    ).toEqual({
      name: PACKAGE_SERVER_NAME,
      version: PACKAGE_SERVER_VERSION,
      gitCommit: "abc123",
      buildDate: "2026-03-10T00:00:00Z",
    });
  });
});
