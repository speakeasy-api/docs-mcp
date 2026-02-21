import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider
} from "../src/embedding.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("embedding providers", () => {
  it("hash provider is deterministic and dimensioned", async () => {
    const provider = new HashEmbeddingProvider({ dimensions: 8 });
    const [a, b, c] = await provider.embed(["hello", "hello", "world"]);

    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("noop provider returns empty vectors", async () => {
    const provider = new NoopEmbeddingProvider();
    const vectors = await provider.embed(["x", "y"]);
    expect(vectors).toEqual([[], []]);
  });

  it("factory validates unsupported providers", () => {
    expect(() =>
      createEmbeddingProvider({
        // @ts-expect-error testing runtime guard
        provider: "unknown"
      })
    ).toThrow(/unsupported embedding provider/);
  });

  it("retries retryable OpenAI failures and preserves result order", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "0"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [0, 1] }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test",
      dimensions: 2,
      batchSize: 2,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2
    });
    const vectors = await provider.embed(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1]
    ]);
  });
});
