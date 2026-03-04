import { describe, expect, it } from "vitest";
import { extractFirstH1 } from "../src/parser.js";

describe("extractFirstH1", () => {
  it("returns the text of the first H1 heading", () => {
    expect(extractFirstH1("# Hello World\n\nSome content")).toBe("Hello World");
  });

  it("returns undefined when there is no H1", () => {
    expect(extractFirstH1("## Second level\n\nSome content")).toBeUndefined();
  });

  it("skips YAML frontmatter and finds the H1", () => {
    const md = ["---", "key: value", "---", "# My Title", "Body text"].join("\n");
    expect(extractFirstH1(md)).toBe("My Title");
  });

  it("returns the first H1 when there are multiple", () => {
    const md = ["# First", "Some text", "# Second"].join("\n");
    expect(extractFirstH1(md)).toBe("First");
  });

  it("returns undefined for an empty H1", () => {
    expect(extractFirstH1("#")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(extractFirstH1("")).toBeUndefined();
  });

  it("handles inline formatting in H1", () => {
    expect(extractFirstH1("# Hello **bold** world")).toBe("Hello bold world");
  });
});
