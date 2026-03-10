import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSourceRefs, inferLang, parseSourceRefAttributes } from "../source-ref.js";

describe("parseSourceRefAttributes", () => {
  it("parses minimal path-only directive", () => {
    expect(parseSourceRefAttributes("path=../src/user.ts")).toEqual({
      path: "../src/user.ts",
    });
  });

  it("parses all attributes", () => {
    expect(
      parseSourceRefAttributes("path=../src/config.go startLine=10 endLine=45 lang=go"),
    ).toEqual({
      path: "../src/config.go",
      startLine: 10,
      endLine: 45,
      lang: "go",
    });
  });

  it("parses quoted path values", () => {
    expect(parseSourceRefAttributes('path="some path/file.ts"')).toEqual({
      path: "some path/file.ts",
    });
  });

  it("throws on unknown attributes", () => {
    expect(() => parseSourceRefAttributes("path=foo.ts unknown=bar")).toThrow(
      "Unknown SourceRef attribute 'unknown'",
    );
  });

  it("throws on missing path", () => {
    expect(() => parseSourceRefAttributes("lang=go")).toThrow(
      "SourceRef missing required 'path' attribute",
    );
  });

  it("throws on malformed content", () => {
    expect(() => parseSourceRefAttributes("path=foo.ts garbage")).toThrow("Malformed SourceRef");
  });

  it("throws on non-integer startLine", () => {
    expect(() => parseSourceRefAttributes("path=foo.ts startLine=abc")).toThrow(
      "SourceRef startLine must be a positive integer",
    );
  });

  it("throws on zero startLine", () => {
    expect(() => parseSourceRefAttributes("path=foo.ts startLine=0")).toThrow(
      "SourceRef startLine must be a positive integer",
    );
  });
});

describe("inferLang", () => {
  it("maps common extensions", () => {
    expect(inferLang("foo.ts")).toBe("typescript");
    expect(inferLang("bar.py")).toBe("python");
    expect(inferLang("baz.go")).toBe("go");
    expect(inferLang("qux.rb")).toBe("ruby");
    expect(inferLang("x.sql")).toBe("sql");
  });

  it("falls back to raw extension for unknown types", () => {
    expect(inferLang("file.zig")).toBe("zig");
  });
});

describe("expandSourceRefs", () => {
  let root: string;
  let docsDir: string;
  let srcDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sourceref-"));
    docsDir = path.join(root, "docs");
    srcDir = path.join(root, "src");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(docsDir, "models"), { recursive: true });
    mkdirSync(path.join(srcDir, "models"), { recursive: true });
  });

  it("expands a simple SourceRef", () => {
    writeFileSync(
      path.join(srcDir, "models", "user.ts"),
      "export interface User {\n  name: string;\n}\n",
    );

    const md = "# User\n\n<!-- SourceRef path=../../src/models/user.ts -->\n\nMore text.";
    const result = expandSourceRefs(md, {
      markdownDir: path.join(docsDir, "models"),
      docsDir,
    });

    expect(result).toContain("```typescript");
    expect(result).toContain("// ref: src/models/user.ts");
    expect(result).toContain("export interface User {");
    expect(result).toContain("More text.");
    expect(result).not.toContain("SourceRef");
  });

  it("respects startLine and endLine", () => {
    writeFileSync(
      path.join(srcDir, "config.go"),
      "package config\n\nconst A = 1\nconst B = 2\nconst C = 3\n",
    );

    const md = "<!-- SourceRef path=../src/config.go startLine=3 endLine=4 lang=go -->";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("```go");
    expect(result).toContain("const A = 1");
    expect(result).toContain("const B = 2");
    expect(result).not.toContain("package config");
    expect(result).not.toContain("const C = 3");
  });

  it("clamps out-of-bounds line ranges silently", () => {
    writeFileSync(path.join(srcDir, "tiny.ts"), "line1\nline2\n");

    const md = "<!-- SourceRef path=../src/tiny.ts startLine=1 endLine=999 -->";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("uses # comment syntax for Python", () => {
    writeFileSync(path.join(srcDir, "lib.py"), "def hello():\n    pass\n");

    const md = "<!-- SourceRef path=../src/lib.py -->";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("```python");
    expect(result).toContain("# ref: src/lib.py");
  });

  it("uses -- comment syntax for SQL", () => {
    writeFileSync(path.join(srcDir, "query.sql"), "SELECT 1;\n");

    const md = "<!-- SourceRef path=../src/query.sql -->";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("```sql");
    expect(result).toContain("-- ref: src/query.sql");
  });

  it("throws on missing file", () => {
    const md = "<!-- SourceRef path=../src/missing.ts -->";
    expect(() => expandSourceRefs(md, { markdownDir: docsDir, docsDir })).toThrow(
      "SourceRef file not found",
    );
  });

  it("throws on .md target", () => {
    writeFileSync(path.join(srcDir, "readme.md"), "# Hi");

    const md = "<!-- SourceRef path=../src/readme.md -->";
    expect(() => expandSourceRefs(md, { markdownDir: docsDir, docsDir })).toThrow(
      "recursive inlining not allowed",
    );
  });

  it("throws on unknown attributes", () => {
    const md = "<!-- SourceRef path=../src/foo.ts bad=true -->";
    expect(() => expandSourceRefs(md, { markdownDir: docsDir, docsDir })).toThrow(
      "Unknown SourceRef attribute",
    );
  });

  it("returns markdown unchanged when no directives present", () => {
    const md = "# Hello\n\nNo source refs here.";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });
    expect(result).toBe(md);
  });

  it("caches file reads across multiple directives", () => {
    writeFileSync(path.join(srcDir, "shared.ts"), "export const X = 1;\n");

    const md = [
      "<!-- SourceRef path=../src/shared.ts -->",
      "",
      "<!-- SourceRef path=../src/shared.ts -->",
    ].join("\n");

    const cache = new Map<string, string>();
    expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
      fileCache: cache,
    });

    // Cache should have exactly one entry
    expect(cache.size).toBe(1);
  });

  it("expands multiple directives in one file", () => {
    writeFileSync(path.join(srcDir, "a.ts"), "const A = 1;\n");
    writeFileSync(path.join(srcDir, "b.py"), "B = 2\n");

    const md = [
      "# Types",
      "",
      "<!-- SourceRef path=../src/a.ts -->",
      "",
      "<!-- SourceRef path=../src/b.py -->",
    ].join("\n");

    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("```typescript");
    expect(result).toContain("```python");
    expect(result).toContain("const A = 1;");
    expect(result).toContain("B = 2");
  });

  it("allows lang override", () => {
    writeFileSync(path.join(srcDir, "template.txt"), "some content\n");

    const md = "<!-- SourceRef path=../src/template.txt lang=yaml -->";
    const result = expandSourceRefs(md, {
      markdownDir: docsDir,
      docsDir,
    });

    expect(result).toContain("```yaml");
  });

  it("computes ref from the filesystem root when that is the only common ancestor", () => {
    const source = path.resolve("tmp-source-ref-root-common.ts");
    writeFileSync(source, "export const rootOnly = true;\n");

    try {
      const md = `<!-- SourceRef path=${path.relative(docsDir, source)} -->`;
      const result = expandSourceRefs(md, {
        markdownDir: docsDir,
        docsDir,
      });

      expect(result).toContain(`// ref: ${source.slice(1).split(path.sep).join("/")}`);
    } finally {
      rmSync(source, { force: true });
    }
  });
});
