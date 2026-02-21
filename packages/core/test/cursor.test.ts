import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  encodeSearchCursor,
  decodeSearchCursor,
} from "../src/cursor.js";
import type { CursorPayload } from "../src/types.js";

describe("cursor encode/decode", () => {
  // ─── Round-trip tests ──────────────────────────────────────────

  it("round-trips: encode then decode returns the same payload", () => {
    const payload: CursorPayload = { offset: 10, limit: 25 };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it("round-trips with offset 0", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it("round-trips with large offset and limit values", () => {
    const payload: CursorPayload = { offset: 999999, limit: 500 };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  // ─── Encoding format ──────────────────────────────────────────

  it("produces a base64url-encoded string", () => {
    const payload: CursorPayload = { offset: 5, limit: 10 };
    const encoded = encodeCursor(payload);
    // base64url uses [A-Za-z0-9_-] with no padding
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodes the payload as JSON inside base64url", () => {
    const payload: CursorPayload = { offset: 5, limit: 10 };
    const encoded = encodeCursor(payload);
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ offset: 5, limit: 10 });
  });

  // ─── Invalid input ────────────────────────────────────────────

  it("throws on invalid base64 that cannot be parsed as JSON", () => {
    // Buffer.from with base64url is lenient, so the error comes from JSON.parse
    expect(() => decodeCursor("not-valid-base64!!!")).toThrow(
      "Invalid cursor: malformed JSON payload"
    );
  });

  it("throws on valid base64url but invalid JSON", () => {
    const invalidJson = Buffer.from("not json {{{", "utf-8").toString(
      "base64url"
    );
    expect(() => decodeCursor(invalidJson)).toThrow(
      "Invalid cursor: malformed JSON payload"
    );
  });

  it("throws when decoded payload is not an object (string)", () => {
    const encoded = Buffer.from(JSON.stringify("string"), "utf-8").toString(
      "base64url"
    );
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when decoded payload is an array", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2]), "utf-8").toString(
      "base64url"
    );
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when decoded payload is null", () => {
    const encoded = Buffer.from(JSON.stringify(null), "utf-8").toString(
      "base64url"
    );
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  // ─── Missing/invalid fields ───────────────────────────────────

  it("throws when offset is missing", () => {
    const encoded = Buffer.from(
      JSON.stringify({ limit: 10 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when limit is missing", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: 0 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when offset is negative", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: -1, limit: 10 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when limit is zero", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: 0, limit: 0 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when limit is negative", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: 0, limit: -5 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when offset is a float", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: 1.5, limit: 10 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when limit is a float", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: 0, limit: 2.5 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });

  it("throws when offset is a string", () => {
    const encoded = Buffer.from(
      JSON.stringify({ offset: "ten", limit: 10 }),
      "utf-8"
    ).toString("base64url");
    expect(() => decodeCursor(encoded)).toThrow(
      "Invalid cursor: expected { offset:number, limit:number }"
    );
  });
});

describe("search cursor encode/decode", () => {
  const context = { query: "authentication", filters: { language: "typescript" } };

  // ─── Round-trip with signature ─────────────────────────────────

  it("round-trips with signature", () => {
    const payload: CursorPayload = { offset: 10, limit: 5 };
    const encoded = encodeSearchCursor(payload, context);
    const decoded = decodeSearchCursor(encoded, context);
    expect(decoded).toEqual(payload);
  });

  it("returns only offset and limit from decodeSearchCursor (strips internal fields)", () => {
    const payload: CursorPayload = { offset: 20, limit: 15 };
    const encoded = encodeSearchCursor(payload, context);
    const decoded = decodeSearchCursor(encoded, context);
    expect(Object.keys(decoded).sort()).toEqual(["limit", "offset"]);
  });

  // ─── Signature mismatch ────────────────────────────────────────

  it("throws when cursor signature does not match current context", () => {
    const payload: CursorPayload = { offset: 10, limit: 5 };
    const encoded = encodeSearchCursor(payload, context);
    const differentContext = { query: "pagination", filters: {} };
    expect(() => decodeSearchCursor(encoded, differentContext)).toThrow(
      "Invalid cursor: does not match current query or filters"
    );
  });

  it("throws when filters differ", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded = encodeSearchCursor(payload, {
      query: "test",
      filters: { lang: "go" },
    });
    expect(() =>
      decodeSearchCursor(encoded, { query: "test", filters: { lang: "rust" } })
    ).toThrow("Invalid cursor: does not match current query or filters");
  });

  // ─── Plain cursor used as search cursor ────────────────────────

  it("throws when a plain cursor is decoded as a search cursor", () => {
    const payload: CursorPayload = { offset: 10, limit: 5 };
    const encoded = encodeCursor(payload);
    expect(() => decodeSearchCursor(encoded, context)).toThrow(
      "Invalid cursor: expected a search cursor payload"
    );
  });

  // ─── Signature determinism ─────────────────────────────────────

  it("same query and filters produce the same encoded cursor signature", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded1 = encodeSearchCursor(payload, {
      query: "test",
      filters: { a: "1", b: "2" },
    });
    const encoded2 = encodeSearchCursor(payload, {
      query: "test",
      filters: { a: "1", b: "2" },
    });
    expect(encoded1).toBe(encoded2);
  });

  it("different queries produce different cursor signatures", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded1 = encodeSearchCursor(payload, {
      query: "auth",
      filters: {},
    });
    const encoded2 = encodeSearchCursor(payload, {
      query: "pagination",
      filters: {},
    });
    expect(encoded1).not.toBe(encoded2);
  });

  it("filter key order does not affect the signature", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded1 = encodeSearchCursor(payload, {
      query: "test",
      filters: { a: "1", b: "2" },
    });
    const encoded2 = encodeSearchCursor(payload, {
      query: "test",
      filters: { b: "2", a: "1" },
    });
    expect(encoded1).toBe(encoded2);
  });

  it("query whitespace trimming produces the same signature", () => {
    const payload: CursorPayload = { offset: 0, limit: 10 };
    const encoded1 = encodeSearchCursor(payload, {
      query: "test",
      filters: {},
    });
    const encoded2 = encodeSearchCursor(payload, {
      query: "  test  ",
      filters: {},
    });
    expect(encoded1).toBe(encoded2);
  });
});
