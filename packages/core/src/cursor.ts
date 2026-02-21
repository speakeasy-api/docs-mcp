import { createHash } from "node:crypto";
import type { CursorPayload } from "./types.js";

interface SearchCursorPayload extends CursorPayload {
  v: 1;
  sig: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return encodePayload(payload);
}

export function decodeCursor(cursor: string): CursorPayload {
  const payload = decodePayload(cursor);
  if (!isCursorPayload(payload)) {
    throw new Error("Invalid cursor: expected { offset:number, limit:number }");
  }

  return payload;
}

export function encodeSearchCursor(
  payload: CursorPayload,
  context: { query: string; filters: Record<string, string> }
): string {
  const searchPayload: SearchCursorPayload = {
    ...payload,
    v: 1,
    sig: computeSearchCursorSignature(context)
  };
  return encodePayload(searchPayload);
}

export function decodeSearchCursor(
  cursor: string,
  context: { query: string; filters: Record<string, string> }
): CursorPayload {
  const payload = decodePayload(cursor);
  if (!isSearchCursorPayload(payload)) {
    throw new Error("Invalid cursor: expected a search cursor payload");
  }

  const expectedSignature = computeSearchCursorSignature(context);
  if (payload.sig !== expectedSignature) {
    throw new Error("Invalid cursor: does not match current query or filters");
  }

  return {
    offset: payload.offset,
    limit: payload.limit
  };
}

function encodePayload(payload: unknown): string {
  const body = JSON.stringify(payload);
  return Buffer.from(body, "utf8").toString("base64url");
}

function decodePayload(cursor: string): unknown {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid cursor: not valid base64url");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new Error("Invalid cursor: malformed JSON payload");
  }
  return payload;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as unknown as Record<string, unknown>;
  return (
    Number.isInteger(payload.offset) &&
    Number.isInteger(payload.limit) &&
    (payload.offset as number) >= 0 &&
    (payload.limit as number) > 0
  );
}

function isSearchCursorPayload(value: unknown): value is SearchCursorPayload {
  if (!isCursorPayload(value)) {
    return false;
  }

  const payload = value as unknown as Record<string, unknown>;
  return payload.v === 1 && typeof payload.sig === "string" && payload.sig.length > 0;
}

function computeSearchCursorSignature(input: {
  query: string;
  filters: Record<string, string>;
}): string {
  const query = input.query.trim();
  const normalizedFilters = Object.entries(input.filters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value]);

  const serialized = JSON.stringify({
    query,
    filters: normalizedFilters
  });

  return createHash("sha1").update(serialized, "utf8").digest("base64url");
}
