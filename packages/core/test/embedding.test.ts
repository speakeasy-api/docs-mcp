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

  it("warns when truncating oversized embedding input", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 0] }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test",
      dimensions: 2,
      batchSize: 128
    });

    // Send text that exceeds the 24,000-char safety net
    const oversizedText = "x".repeat(25_000);
    await provider.embed([oversizedText]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Embedding input truncated from 25000 to 24000")
    );

    // Verify the text was actually truncated in the request
    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string
    ) as { input: string[] };
    expect(requestBody.input[0]).toHaveLength(24_000);
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
