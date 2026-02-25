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

  it("embed() uses batch API when texts.length >= threshold", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const progressEvents: Array<{ phase: string; message: string }> = [];

    // 0. List batches (no match)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    // 1. Upload file
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "file-abc123" }), { status: 200 })
    );
    // 2. Create batch
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "batch-xyz789" }), { status: 200 })
    );
    // 3. Poll — first returns in_progress with request_counts
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "in_progress",
        request_counts: { total: 3, completed: 1, failed: 0 },
      }), { status: 200 })
    );
    // 4. Poll — returns completed
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", output_file_id: "file-out456" }),
        { status: 200 }
      )
    );
    // 5. Download results — 3 results in JSONL (out of order to test reordering)
    const resultJsonl = [
      JSON.stringify({ custom_id: "req-2", response: { body: { data: [{ embedding: [0, 0, 1] }] } } }),
      JSON.stringify({ custom_id: "req-0", response: { body: { data: [{ embedding: [1, 0, 0] }] } } }),
      JSON.stringify({ custom_id: "req-1", response: { body: { data: [{ embedding: [0, 1, 0] }] } } }),
    ].join("\n");
    fetchMock.mockResolvedValueOnce(
      new Response(resultJsonl, { status: 200 })
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      batchApiThreshold: 3,
      onBatchProgress: (event) => progressEvents.push({ phase: event.phase, message: event.message }),
    });

    const embedPromise = provider.embed(["text-a", "text-b", "text-c"]);

    // Advance past the poll sleep interval
    await vi.advanceTimersByTimeAsync(15_000);

    const vectors = await embedPromise;

    // Verify correct reordering
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);

    // Verify JSONL format of the upload (call index 1 — after list batches)
    const uploadCall = fetchMock.mock.calls[1]!;
    expect(uploadCall[0]).toContain("/files");
    const uploadBody = uploadCall[1]!.body as FormData;
    const fileBlob = uploadBody.get("file") as Blob;
    const jsonlContent = await fileBlob.text();
    const lines = jsonlContent.split("\n");
    expect(lines).toHaveLength(3);
    const firstLine = JSON.parse(lines[0]!) as { custom_id: string; method: string; url: string; body: { model: string; input: string; dimensions: number } };
    expect(firstLine.custom_id).toBe("req-0");
    expect(firstLine.method).toBe("POST");
    expect(firstLine.url).toBe("/v1/embeddings");
    expect(firstLine.body.input).toBe("text-a");

    // Verify content_sha is stored in batch creation metadata
    const createCall = fetchMock.mock.calls[2]!;
    const createBody = JSON.parse(createCall[1]!.body as string) as { metadata?: { content_sha?: string } };
    expect(createBody.metadata?.content_sha).toMatch(/^[0-9a-f]{64}$/);

    // Verify progress was reported
    expect(progressEvents.some((e) => e.phase === "batch-uploading")).toBe(true);
    expect(progressEvents.some((e) => e.phase === "batch-polling")).toBe(true);
    expect(progressEvents.some((e) => e.phase === "batch-downloading")).toBe(true);

    // Verify countdown messages (10s interval → ticks at 10, 9, 8, ... 1)
    const pollingMessages = progressEvents.filter((e) => e.phase === "batch-polling");
    expect(pollingMessages.length).toBe(10);
    expect(pollingMessages[0]!.message).toMatch(/Next poll in 10s/);
    expect(pollingMessages[0]!.message).toMatch(/1\/3 \(33\.3%\)/);
    expect(pollingMessages[9]!.message).toMatch(/Next poll in 1s/);

    vi.useRealTimers();
  });

  it("embed() uses synchronous path when texts.length < threshold", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 2,
      batchSize: 128,
      batchApiThreshold: 5,
    });

    const vectors = await provider.embed(["text-a", "text-b"]);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    // Should use the sync /embeddings endpoint, not /files
    expect(fetchMock.mock.calls[0]![0]).toContain("/embeddings");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("batch API throws on failed batch status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // 0. List batches (no match)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    // 1. Upload
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "file-abc" }), { status: 200 })
    );
    // 2. Create batch
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "batch-xyz" }), { status: 200 })
    );
    // 3. Poll returns failed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "failed" }), { status: 200 })
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 2,
      batchApiThreshold: 2,
    });

    await expect(provider.embed(["a", "b"])).rejects.toThrow("OpenAI batch failed");
  });

  it("batch API reports progress via onBatchProgress callback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const events: string[] = [];

    // 0. List batches (no match)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    // 1. Upload
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "file-abc" }), { status: 200 })
    );
    // 2. Create batch
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "batch-xyz" }), { status: 200 })
    );
    // 3. Poll — completed immediately
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "completed", output_file_id: "file-out" }),
        { status: 200 }
      )
    );
    // 4. Download results
    const resultJsonl = [
      JSON.stringify({ custom_id: "req-0", response: { body: { data: [{ embedding: [1, 0] }] } } }),
      JSON.stringify({ custom_id: "req-1", response: { body: { data: [{ embedding: [0, 1] }] } } }),
    ].join("\n");
    fetchMock.mockResolvedValueOnce(
      new Response(resultJsonl, { status: 200 })
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 2,
      batchApiThreshold: 2,
      onBatchProgress: (event) => events.push(event.phase),
    });

    await provider.embed(["a", "b"]);

    expect(events).toContain("batch-uploading");
    expect(events).toContain("batch-downloading");
  });

  it("resumes a completed batch found via content_sha", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const events: string[] = [];

    // 0. List batches — returns a completed batch with matching content_sha
    // We need the SHA to match the JSONL built from ["a", "b"] with model/dimensions defaults.
    // Since we can't predict the exact SHA, we use a dynamic approach:
    // mock findExistingBatch to always return a match by including a wildcard content_sha.
    // Instead, we'll rely on the fact that the provider builds JSONL deterministically,
    // so two providers with the same config and inputs produce the same SHA.
    // We'll build the expected SHA by constructing a second provider.
    const { sha256hex } = await import("../src/embedding.js");
    const refProvider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 2,
      batchApiThreshold: 2,
    });
    // Build the JSONL the provider would create (access via same logic)
    const expectedJsonl = [
      JSON.stringify({ custom_id: "req-0", method: "POST", url: "/v1/embeddings", body: { model: "text-embedding-3-large", input: "a", dimensions: 2 } }),
      JSON.stringify({ custom_id: "req-1", method: "POST", url: "/v1/embeddings", body: { model: "text-embedding-3-large", input: "b", dimensions: 2 } }),
    ].join("\n");
    const contentSha = sha256hex(expectedJsonl);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{
          id: "batch-existing",
          status: "completed",
          output_file_id: "file-existing-out",
          metadata: { content_sha: contentSha },
        }],
      }), { status: 200 })
    );
    // 1. Download results (skips upload/create/poll entirely)
    const resultJsonl = [
      JSON.stringify({ custom_id: "req-0", response: { body: { data: [{ embedding: [1, 0] }] } } }),
      JSON.stringify({ custom_id: "req-1", response: { body: { data: [{ embedding: [0, 1] }] } } }),
    ].join("\n");
    fetchMock.mockResolvedValueOnce(
      new Response(resultJsonl, { status: 200 })
    );

    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 2,
      batchApiThreshold: 2,
      onBatchProgress: (event) => events.push(event.phase),
    });

    const vectors = await provider.embed(["a", "b"]);

    expect(vectors).toEqual([[1, 0], [0, 1]]);
    // Only 2 fetch calls: list batches + download (no upload/create/poll)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContain("batch-downloading");
    expect(events).not.toContain("batch-uploading");
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
