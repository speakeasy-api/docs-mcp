import { describe, expect, it } from "vitest";
import { properCase } from "../src/strings.js";

describe("properCase", () => {
  it("returns canonical form for a single dictionary word", () => {
    expect(properCase("typescript")).toBe("TypeScript");
    expect(properCase("TYPESCRIPT")).toBe("TypeScript");
    expect(properCase("javascript")).toBe("JavaScript");
    expect(properCase("openai")).toBe("OpenAI");
    expect(properCase("api")).toBe("API");
  });

  it("returns single unrecognized words unchanged", () => {
    expect(properCase("guides")).toBe("guides");
    expect(properCase("Guides")).toBe("Guides");
    expect(properCase("hello")).toBe("hello");
  });

  it("preserves single all-uppercase unrecognized words", () => {
    expect(properCase("FOOBAR")).toBe("FOOBAR");
    expect(properCase("XYZ")).toBe("XYZ");
  });

  it("resolves individual words in space-separated strings", () => {
    expect(properCase("my api")).toBe("my API");
    expect(properCase("typescript sdk")).toBe("TypeScript SDK");
    expect(properCase("Get openai api Key")).toBe("Get OpenAI API Key");
  });

  it("resolves individual words in hyphen-separated strings", () => {
    expect(properCase("api-key")).toBe("API-key");
    expect(properCase("api-KEY")).toBe("API-KEY");
    expect(properCase("typescript-sdk")).toBe("TypeScript-SDK");
  });

  it("preserves all-uppercase words in multi-word strings", () => {
    expect(properCase("MY CUSTOM THING")).toBe("MY CUSTOM THING");
    expect(properCase("MY api")).toBe("MY API");
  });

  it("preserves original delimiters", () => {
    expect(properCase("a-b c")).toBe("a-b c");
    expect(properCase("api-sdk key")).toBe("API-SDK key");
  });

  it("returns unrecognized multi-word string unchanged when nothing resolves", () => {
    expect(properCase("hello world")).toBe("hello world");
    expect(properCase("foo-bar")).toBe("foo-bar");
  });
});
