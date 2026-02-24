import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ManifestSchema } from "../src/manifest-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../../../schemas/docs-mcp.schema.json");

const jsonSchema = z.toJSONSchema(ManifestSchema, { target: "draft-2020-12" });

const content = JSON.stringify(jsonSchema, null, 2) + "\n";
writeFileSync(outPath, content);

console.log(`Wrote JSON schema to ${outPath}`);
