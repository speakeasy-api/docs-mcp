import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLlmsGoChunks } from "../src/llms-go.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("buildLlmsGoChunks", () => {
  it("extracts entrypoint, method, and type chunks from annotated declarations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-llms-go-"));
    tempDirs.push(root);

    const llmsDir = path.join(root, "llms");
    await mkdir(llmsDir, { recursive: true });
    await writeFile(
      path.join(llmsDir, "demo.go"),
      [
        "package demo",
        "",
        "// kind: entrypoint",
        'const ServerURL = "https://example.com"',
        "",
        "// kind: entrypoint",
        "type SDK struct {",
        "\tSDKVersion string",
        "}",
        "",
        "// kind: entrypoint",
        "// New creates a new SDK instance",
        "func New(serverURL string, opts ...SDKOption) *SDK {",
        "\treturn nil",
        "}",
        "",
        "// kind: type",
        "type Tenants struct {",
        "}",
        "",
        "// kind: method",
        "// GetTenant gets a tenant",
        "func (s *Tenants) GetTenant(ctx context.Context, id string, opts ...operations.Option) (*operations.GetTenantResponse, error) {",
        "\treturn nil, nil",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(llmsDir, "registry.json"),
      JSON.stringify(
        {
          symbols: [
            {
              id: "method:demo.(*Tenants).GetTenant",
              name: "GetTenant",
              sdkImport: "demo",
              uses: ["type:demo/models/operations.GetTenantRequest"]
            },
            {
              id: "type:demo/models/operations.GetTenantRequest",
              name: "GetTenantRequest",
              sdkImport: "demo/models/operations",
              uses: []
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const chunks = await buildLlmsGoChunks(llmsDir);

    const entrypointChunks = chunks.filter((c) => c.metadata.kind === "entrypoint");
    expect(entrypointChunks.length).toBe(3);
    expect(entrypointChunks.map((c) => c.heading)).toEqual(
      expect.arrayContaining(["ServerURL", "SDK", "New"])
    );
    expect(entrypointChunks.every((c) => c.metadata.entrypoint === "true")).toBe(true);

    const methodChunk = chunks.find((c) => c.heading === "Tenants.GetTenant");
    expect(methodChunk).toBeTruthy();
    expect(methodChunk?.metadata.kind).toBe("method");
    expect(methodChunk?.metadata.owner).toBe("Tenants");
    expect(methodChunk?.content).toContain("type:demo/models/operations.GetTenantRequest");
    expect(methodChunk?.content).not.toContain("// kind:");

    const typeChunk = chunks.find((c) => c.heading === "Tenants" && c.metadata.kind === "type");
    expect(typeChunk).toBeTruthy();
    expect(typeChunk?.content).not.toContain("// kind:");
  });

  it("skips declarations without kind annotation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "docs-mcp-llms-go-"));
    tempDirs.push(root);

    const llmsDir = path.join(root, "llms");
    await mkdir(llmsDir, { recursive: true });
    await writeFile(
      path.join(llmsDir, "demo.go"),
      [
        "package demo",
        "",
        "type Unannotated struct {}",
        "",
        "// kind: entrypoint",
        "type SDK struct {}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(llmsDir, "registry.json"),
      JSON.stringify({ symbols: [] }, null, 2),
      "utf8"
    );

    const chunks = await buildLlmsGoChunks(llmsDir);
    expect(chunks.find((c) => c.heading === "Unannotated")).toBeUndefined();
    expect(chunks.find((c) => c.heading === "SDK")).toBeTruthy();
  });
});
