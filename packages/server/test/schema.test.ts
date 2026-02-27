import { describe, expect, it } from "vitest";
import { CreateDocsServerOptionsSchema, type CreateDocsServerOptionsInput, type CreateDocsServerOptions } from "../src/create.js";

describe("CreateDocsServerOptionsSchema", () => {
  it("validates a minimal config with just indexDir", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({ indexDir: "./my-index" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.indexDir).toBe("./my-index");
      expect(result.data.customTools).toEqual([]);
    }
  });

  it("validates a full config with all optional fields", () => {
    const input: CreateDocsServerOptionsInput = {
      indexDir: "./my-index",
      toolPrefix: "acme",
      queryEmbeddingApiKey: "sk-test",
      queryEmbeddingBaseUrl: "https://api.example.com",
      queryEmbeddingBatchSize: 100,
      proximityWeight: 1.5,
      phraseSlop: 2,
      vectorWeight: 3.0,
      customTools: [
        {
          name: "my_tool",
          description: "A custom tool",
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
        }
      ]
    };

    const result = CreateDocsServerOptionsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolPrefix).toBe("acme");
      expect(result.data.phraseSlop).toBe(2);
      expect(result.data.customTools).toHaveLength(1);
    }
  });

  it("rejects missing indexDir", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty indexDir", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({ indexDir: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid toolPrefix characters", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      toolPrefix: "bad prefix!"
    });
    expect(result.success).toBe(false);
  });

  it("rejects phraseSlop out of range", () => {
    const high = CreateDocsServerOptionsSchema.safeParse({ indexDir: "./x", phraseSlop: 10 });
    expect(high.success).toBe(false);

    const negative = CreateDocsServerOptionsSchema.safeParse({ indexDir: "./x", phraseSlop: -1 });
    expect(negative.success).toBe(false);
  });

  it("rejects non-positive proximityWeight", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      proximityWeight: 0
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive vectorWeight", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      vectorWeight: -1
    });
    expect(result.success).toBe(false);
  });

  it("rejects custom tool with invalid name", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      customTools: [{
        name: "invalid name!",
        description: "test",
        inputSchema: { type: "object" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
      }]
    });
    expect(result.success).toBe(false);
  });

  it("rejects custom tool with non-object inputSchema", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      customTools: [{
        name: "my_tool",
        description: "test",
        inputSchema: { type: "string" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
      }]
    });
    expect(result.success).toBe(false);
  });

  it("rejects custom tool with empty description", () => {
    const result = CreateDocsServerOptionsSchema.safeParse({
      indexDir: "./x",
      customTools: [{
        name: "my_tool",
        description: "",
        inputSchema: { type: "object" },
        handler: async () => ({ content: [{ type: "text", text: "ok" }], isError: false })
      }]
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting defaulted fields in input type", () => {
    // This is a compile-time check — if CreateDocsServerOptionsInput requires
    // customTools, this won't compile.
    const input: CreateDocsServerOptionsInput = { indexDir: "./x" };
    const result = CreateDocsServerOptionsSchema.parse(input);
    expect(result.customTools).toEqual([]);
  });

  it("has required fields after parse in output type", () => {
    const parsed: CreateDocsServerOptions = CreateDocsServerOptionsSchema.parse({
      indexDir: "./x"
    });
    // These are always present after parse due to .default()
    const _tools: unknown[] = parsed.customTools;
    expect(_tools).toEqual([]);
  });
});
