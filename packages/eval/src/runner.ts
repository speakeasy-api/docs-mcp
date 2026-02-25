import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { EvalSummary, RankedCase } from "./metrics.js";
import { summarizeCases } from "./metrics.js";

const execFileAsync = promisify(execFile);

export interface EvalRunInput {
  cases: RankedCase[];
  timings?: {
    searchLatenciesMs?: number[];
    getDocLatenciesMs?: number[];
    buildTimeMs?: number;
    peakRssMb?: number;
  };
  model?: {
    provider: string;
    model: string;
  };
  deterministic?: boolean;
}

export interface EvalRunOutput {
  summary: EvalSummary;
  metadata: {
    deterministic: boolean;
    provider: string | null;
    model: string | null;
  };
}

export interface EvalServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface EvalBuildConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface EvalQueryCase {
  query: string;
  expectedChunkId: string;
  filters?: Record<string, string>;
  limit?: number;
  maxRounds?: number;
  name?: string;
  category?: string;
}

export interface EvalHarnessInput {
  server: EvalServerConfig;
  build?: EvalBuildConfig;
  cases: EvalQueryCase[];
  warmupQueries?: number;
  model?: {
    provider: string;
    model: string;
  };
  deterministic?: boolean;
}

export interface EvalHarnessOutput extends EvalRunOutput {
  rankedCases: RankedCase[];
  stats: {
    searchLatenciesMs: number[];
    getDocLatenciesMs: number[];
    buildTimeMs: number;
    peakRssMb: number;
  };
}

export function runEvaluation(input: EvalRunInput): EvalRunOutput {
  const summary = summarizeCases(input.cases, input.timings);
  return {
    summary,
    metadata: {
      deterministic: input.deterministic ?? true,
      provider: input.model?.provider ?? null,
      model: input.model?.model ?? null
    }
  };
}

export async function runEvaluationAgainstServer(
  input: EvalHarnessInput
): Promise<EvalHarnessOutput> {
  const buildTimeMs = input.build ? await runBuildStep(input.build) : 0;

  const serverParams: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  } = {
    command: input.server.command
  };

  if (input.server.args !== undefined) {
    serverParams.args = input.server.args;
  }
  if (input.server.cwd !== undefined) {
    serverParams.cwd = input.server.cwd;
  }
  if (input.server.env !== undefined) {
    serverParams.env = input.server.env;
  }

  const transport = new StdioClientTransport(serverParams);

  const client = new Client(
    {
      name: "@speakeasy-api/docs-mcp-eval",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );

  await client.connect(transport);
  const rssSampler = createRssSampler(transport.pid);
  await rssSampler.start();

  try {
    await client.listTools();
    await warmupServer(client, input.cases, input.warmupQueries ?? 0);

    const rankedCases: RankedCase[] = [];
    const searchLatenciesMs: number[] = [];
    const getDocLatenciesMs: number[] = [];

    for (const testCase of input.cases) {
      const executed = await executeCase(client, testCase);
      rankedCases.push(executed.rankedCase);
      searchLatenciesMs.push(...executed.searchLatenciesMs);
      getDocLatenciesMs.push(...executed.getDocLatenciesMs);
    }
    const peakRssMb = await rssSampler.stop();

    const output = runEvaluation({
      cases: rankedCases,
      timings: {
        searchLatenciesMs,
        getDocLatenciesMs,
        buildTimeMs,
        peakRssMb
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.deterministic !== undefined ? { deterministic: input.deterministic } : {})
    });

    return {
      ...output,
      rankedCases,
      stats: {
        searchLatenciesMs,
        getDocLatenciesMs,
        buildTimeMs,
        peakRssMb
      }
    };
  } finally {
    await rssSampler.stop();
    await transport.close();
  }
}

async function executeCase(
  client: Client,
  testCase: EvalQueryCase
): Promise<{
  rankedCase: RankedCase;
  searchLatenciesMs: number[];
  getDocLatenciesMs: number[];
}> {
  const rankedChunkIds: string[] = [];
  const seen = new Set<string>();
  const searchLatenciesMs: number[] = [];
  const getDocLatenciesMs: number[] = [];

  let rounds = 0;
  let cursor: string | undefined;
  const maxRounds = testCase.maxRounds ?? 3;

  while (rounds < maxRounds) {
    rounds += 1;

    const args: Record<string, unknown> = {
      query: testCase.query,
      limit: testCase.limit ?? 5,
      ...(testCase.filters ?? {})
    };

    if (cursor) {
      args.cursor = cursor;
    }

    const searchStart = performance.now();
    const toolResult = await client.callTool({
      name: "search_docs",
      arguments: args
    });
    searchLatenciesMs.push(performance.now() - searchStart);

    if ("toolResult" in toolResult) {
      throw new Error("Unexpected compatibility tool result shape from server");
    }

    if (toolResult.isError) {
      throw new Error(readTextContent(toolResult.content) || "search_docs returned an unknown error");
    }

    const payload = parseSearchResultText(readTextContent(toolResult.content));
    for (const hit of payload.hits) {
      if (!seen.has(hit.chunk_id)) {
        rankedChunkIds.push(hit.chunk_id);
        seen.add(hit.chunk_id);
      }
    }

    const targetHit = payload.hits.find((hit) => hit.chunk_id === testCase.expectedChunkId);
    if (targetHit) {
      const getDocStart = performance.now();
      const getDocResult = await client.callTool({
        name: "get_doc",
        arguments: {
          chunk_id: targetHit.chunk_id,
          context: 0
        }
      });
      getDocLatenciesMs.push(performance.now() - getDocStart);

      if ("toolResult" in getDocResult) {
        throw new Error("Unexpected compatibility tool result shape from server");
      }
      if (getDocResult.isError) {
        throw new Error(readTextContent(getDocResult.content) || "get_doc returned an unknown error");
      }

      break;
    }

    cursor = payload.next_cursor ?? undefined;
    if (!cursor) {
      break;
    }
  }

  const roundsToRightDoc = computeRoundsToRightDoc({
    found: rankedChunkIds.includes(testCase.expectedChunkId),
    roundsExecuted: rounds,
    maxRounds
  });

  return {
    rankedCase: {
      expectedChunkId: testCase.expectedChunkId,
      rankedChunkIds,
      roundsToRightDoc,
      ...(testCase.name !== undefined ? { name: testCase.name } : {}),
      ...(testCase.category !== undefined ? { category: testCase.category } : {})
    },
    searchLatenciesMs,
    getDocLatenciesMs
  };
}

export function computeRoundsToRightDoc(input: {
  found: boolean;
  roundsExecuted: number;
  maxRounds: number;
}): number {
  return input.found ? input.roundsExecuted : input.maxRounds + 1;
}

async function warmupServer(
  client: Client,
  cases: EvalQueryCase[],
  warmupQueries: number
): Promise<void> {
  if (warmupQueries <= 0 || cases.length === 0) {
    return;
  }

  for (let i = 0; i < warmupQueries; i += 1) {
    const testCase = cases[i % cases.length];
    if (!testCase) {
      continue;
    }

    const args: Record<string, unknown> = {
      query: testCase.query,
      limit: Math.min(5, testCase.limit ?? 5),
      ...(testCase.filters ?? {})
    };

    try {
      await client.callTool({
        name: "search_docs",
        arguments: args
      });
    } catch {
      // Warmup is best-effort.
    }
  }
}

function readTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n")
    .trim();
}

function parseSearchResultText(text: string): {
  hits: Array<{ chunk_id: string }>;
  next_cursor: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("search_docs result was not valid JSON text");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("search_docs result was not an object");
  }

  const result = parsed as Record<string, unknown>;
  if (!Array.isArray(result.hits)) {
    throw new Error("search_docs result is missing hits[]");
  }

  const hits: Array<{ chunk_id: string }> = [];
  for (const entry of result.hits) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const chunkId = (entry as Record<string, unknown>).chunk_id;
    if (typeof chunkId === "string" && chunkId) {
      hits.push({ chunk_id: chunkId });
    }
  }

  const nextCursorRaw = result.next_cursor;
  const nextCursor = nextCursorRaw === null || typeof nextCursorRaw === "string"
    ? nextCursorRaw
    : null;

  return {
    hits,
    next_cursor: nextCursor
  };
}

async function runBuildStep(config: EvalBuildConfig): Promise<number> {
  const startedAt = performance.now();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env
      },
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Build command failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`
        )
      );
    });
  });

  return performance.now() - startedAt;
}

function createRssSampler(pid: number | null): {
  start: () => Promise<void>;
  stop: () => Promise<number>;
} {
  if (!pid) {
    return {
      async start(): Promise<void> {
        // noop
      },
      async stop(): Promise<number> {
        return 0;
      }
    };
  }

  let interval: ReturnType<typeof setInterval> | undefined;
  let peakRssMb = 0;
  let stopped = false;

  const sample = async (): Promise<void> => {
    try {
      const rssMb = await readProcessRssMb(pid);
      if (rssMb > peakRssMb) {
        peakRssMb = rssMb;
      }
    } catch {
      // RSS sampling is best-effort.
    }
  };

  return {
    async start(): Promise<void> {
      if (stopped || interval) {
        return;
      }
      await sample();
      interval = setInterval(() => {
        void sample();
      }, 200);
      interval.unref();
    },
    async stop(): Promise<number> {
      if (stopped) {
        return peakRssMb;
      }

      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      await sample();
      return Number(peakRssMb.toFixed(6));
    }
  };
}

async function readProcessRssMb(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], {
    windowsHide: true
  });
  const kb = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(kb) || kb <= 0) {
    return 0;
  }
  return kb / 1024;
}
