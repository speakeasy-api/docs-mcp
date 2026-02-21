#!/usr/bin/env node
// Fail fast if `npm publish` is used instead of `pnpm publish`.
// pnpm replaces workspace:* with real versions at pack time; npm does not.
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const [name, version] of Object.entries(pkg[field] || {})) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      console.error(
        `ERROR: ${name} has version "${version}". Use \`pnpm publish\` (or \`pnpm release\` from the repo root) so workspace dependencies are resolved.`,
      );
      process.exit(1);
    }
  }
}
