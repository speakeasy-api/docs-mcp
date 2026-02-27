import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ManifestSchema } from "../src/manifest-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "../../../schemas/docs-mcp.schema.json");

describe("manifest JSON schema", () => {
  it("committed schema matches generated schema from Zod", () => {
    const generated = z.toJSONSchema(ManifestSchema, {
      target: "draft-2020-12",
    });
    const committed = JSON.parse(readFileSync(schemaPath, "utf-8"));

    expect(committed).toEqual(generated);
  });
});
