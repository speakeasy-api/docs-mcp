# Agent Evaluation Framework (`agent-eval`)

The `agent-eval` subcommand of `@speakeasy-api/docs-mcp-eval` runs end-to-end agent evaluations. It spawns an AI coding agent with docs-mcp tools (`search_docs`, `get_doc`), runs it against a prompt, and evaluates assertions on the output. This validates the full stack — from search quality to how well a real model uses the tools to complete a task.

## Providers

The eval supports multiple agent providers via the `--provider` flag:

| Provider | Flag | Backend | Prerequisites |
|----------|------|---------|---------------|
| Anthropic | `--provider anthropic` | `@anthropic-ai/claude-agent-sdk` | `ANTHROPIC_API_KEY` |
| OpenAI Codex | `--provider openai` | `codex exec --json` (CLI spawn) | `OPENAI_API_KEY` + [`codex`](https://github.com/openai/codex) CLI on PATH |
| Auto (default) | `--provider auto` | Detected from environment | Whichever API key is set |

Auto-detection priority: if only `OPENAI_API_KEY` is set, Codex is used; otherwise Anthropic is used (its CLI handles its own auth, or via `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`). If both keys are set, Anthropic is used with a warning.

The Codex provider spawns `codex exec --json` as a child process and injects MCP server configuration via `-c` CLI flags. It performs a pre-flight check to verify the MCP server starts correctly before running the agent.

## Scenario Format

Scenario files are YAML (or JSON, which is valid YAML). The file is an object keyed by scenario ID. Each key is a short, stable identifier used for `--include` filtering and result matching. Keys starting with `_` are ignored (useful for YAML anchors and shared defaults).

```yaml
_defaults: &defaults
  description: &description >-
    AcmeAuth SDK — multi-language authentication client
  docsDir: &docsDir "../../my-docs"

ts-init:
  name: Initialize the TypeScript client
  <<: *defaults
  prompt: >-
    Using the AcmeAuth TypeScript SDK (`@acmeauth/sdk`), write a script in
    solution.ts that initializes the AcmeAuth client with an API key from the
    environment and fetches a user by ID.
  category: sdk-usage
  setup: "npm init -y --silent 2>/dev/null"
  assertions:
    - type: file_contains
      path: solution.ts
      value: AcmeAuth
    - type: file_contains
      path: solution.ts
      value: apiKey
```

Run a specific scenario by ID:

```bash
docs-mcp-eval agent-eval --suite acmeauth --include ts-init
```

### Field Reference

| Field              | Type                         | Required | Default | Description                                                                                            |
| ------------------ | ---------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| _(object key)_     | `string`                     | yes      | —       | Scenario ID — short, stable identifier used for `--include` and result matching                        |
| `name`             | `string`                     | yes      | —       | Human-readable scenario name, shown in output tables                                                   |
| `prompt`           | `string`                     | yes      | —       | The user prompt sent to the agent                                                                      |
| `assertions`       | `AgentAssertion[]`           | yes      | —       | Array of assertions to evaluate against the agent's output                                             |
| `category`         | `string`                     | no       | —       | Grouping tag for per-category breakdown (e.g. `"sdk-usage"`, `"error-handling"`)                       |
| `models`           | `Record<provider, string>`   | no       | —       | Per-provider model overrides (takes precedence over CLI `--model`). Keys: `anthropic`, `openai`        |
| `maxTurns`         | `number`                     | no       | `15`    | Max agent conversation turns for this scenario                                                         |
| `maxBudgetUsd`     | `number`                     | no       | `2.00`  | Max dollar spend for this scenario                                                                     |
| `systemPrompt`     | `string`                     | no       | —       | System prompt given to the agent                                                                       |
| `setup`            | `string`                     | no       | —       | Shell command run in the workspace directory before the agent starts                                   |
| `description`      | `string`                     | no       | —       | Corpus description for the docs index; flows into MCP tool descriptions                               |
| `toolDescriptions` | `{ search_docs?, get_doc? }` | no       | —       | Custom tool descriptions for the MCP server tools (overrides description-derived defaults)             |
| `docsSpec`         | `DocsRepoSpec`               | no       | —       | Git repo to clone and index docs from (takes precedence over `docsDir`)                                |
| `docsDir`          | `string`                     | no       | —       | Path to a local docs directory, resolved relative to the scenario file                                 |
| `links`            | `Record<string, string>`     | no       | —       | Map of source paths (relative to scenario file) to workspace dest paths. Symlinked before `setup` runs |

A scenario **passes** only if it has at least one hard assertion and all hard assertions pass. Soft assertions (`"soft": true`) are still evaluated and displayed in output, but their results do not affect pass/fail.

### Per-Provider Model Overrides

The `models` field lets a scenario use different models depending on which provider is active. This takes precedence over the CLI `--model` flag:

```yaml
my-scenario:
  name: Test with specific models
  models:
    anthropic: claude-sonnet-4-20250514
    openai: o3-mini
  prompt: "..."
  assertions: [...]
```

### Workspace Links

The `links` field symlinks files from the repo into the agent workspace before `setup` runs. Source paths are relative to the scenario file; destination paths are relative to the workspace:

```yaml
my-scenario:
  name: Test with local SDK
  links:
    ../../packages/my-sdk/dist: node_modules/my-sdk
    ../fixtures/tsconfig.json: tsconfig.json
  setup: "npm init -y --silent 2>/dev/null"
  prompt: "..."
  assertions: [...]
```

## Docs Sources

Each scenario needs a documentation corpus. There are two ways to specify one:

### `docsDir` — Local Path

Point to a local docs directory. The path is resolved relative to the scenario file's location.

```yaml
docsDir: "../../my-docs"
```

### `docsSpec` — Clone from Git

Clone a repository and index a subdirectory within it. Useful for evaluating against external SDK documentation.

```yaml
docsSpec:
  url: https://github.com/org/sdk-docs.git
  ref: main
  docsPath: docs/typescript
  docsConfig:
    version: "1"
    strategy:
      chunk_by: h2
    metadata:
      language: typescript
```

| Field        | Type     | Required | Default  | Description                                                                              |
| ------------ | -------- | -------- | -------- | ---------------------------------------------------------------------------------------- |
| `url`        | `string` | yes      | —        | Git clone URL                                                                            |
| `ref`        | `string` | no       | `"main"` | Branch, tag, or commit                                                                   |
| `docsPath`   | `string` | no       | `"."`    | Subdirectory within the repo containing docs                                             |
| `docsConfig` | `object` | no       | —        | Inline `.docs-mcp.json` manifest (written into the docs directory if the repo lacks one) |

### Auto-Build and Caching

The CLI automatically builds a search index for each docs source before running scenarios. Indexes are cached at `.cache/indexes/` keyed by a content hash of the docs directory (file paths, sizes, mtimes, and any `.docs-mcp.json` contents). If the docs haven't changed, the cached index is reused.

For `docsSpec` scenarios, cloned repositories are cached at `.cache/repos/` keyed by a hash of `url + ref`. A `.clone-complete` marker prevents re-cloning on subsequent runs.

Multiple scenarios sharing the same docs directory and description share a single index build.

## Feedback Tool

After completing a task, the agent is instructed to call a feedback tool to report its experience with the documentation. The feedback tool is registered as a custom MCP tool on the docs-mcp server and its responses are captured in the eval results.

By default, the eval uses a built-in feedback tool (`docs_feedback`) with three 0–100 integer metrics: `confidence_score`, `docs_relevance`, and `docs_utilization`, plus a `reasoning` text field.

### Custom Feedback Tool (`_config.feedback_tool`)

Suites can define a custom feedback tool with a different schema, instruction, and metric set via the `_config.feedback_tool` key at the top level of the YAML file:

```yaml
_config:
  feedback_tool:
    name: give_feedback
    description: >-
      Submit feedback about the documentation or a specific doc chunk.
      ALWAYS use this after a task is completed that used the get_doc or search_docs tools.
    instruction: >-
      After completing the task, call the give_feedback tool to share your experience
      with the documentation. Include specific details about what was helpful or confusing.
    input_schema:
      type: object
      properties:
        feedback:
          type: string
          description: The feedback text describing your experience with the documentation.
        rating:
          type: integer
          minimum: 1
          maximum: 5
          description: Overall satisfaction rating from 1 (poor) to 5 (excellent).
        chunk_id:
          type: string
          description: Optional ID of the doc chunk the feedback relates to.
      required:
        - feedback
    metrics:
      - field: rating
        label: Rating
        direction: higher
    reasoning_field: feedback
    headline_field: rating
```

The `_config` key is suite-level only — mixing different feedback schemas within a suite would break metric aggregation. Like other `_`-prefixed keys, it is stripped before scenario parsing.

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | MCP tool name registered on the server (e.g. `give_feedback`) |
| `description` | `string` | yes | Tool description shown to the agent |
| `instruction` | `string` | yes | Text appended to the system prompt instructing the agent to call this tool |
| `input_schema` | `object` | yes | JSON Schema for the tool's input (must be `type: object` with `properties`) |
| `metrics` | `FeedbackMetricSpec[]` | yes | Which fields are numeric metrics to aggregate across scenarios |
| `reasoning_field` | `string` | no | Property name containing free-text reasoning/feedback |
| `headline_field` | `string` | no | Which metric to show in the per-scenario one-liner output |

Each entry in `metrics` has:

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | Property name in `input_schema.properties` |
| `label` | `string` | Display label used in output |
| `direction` | `"higher"` or `"lower"` | Whether higher or lower values are better (used for trend arrows) |

### How It Works

1. The feedback tool config is serialized and passed to the MCP server via `--custom-tools-json`. The server registers each tool with an echo handler that returns the agent's input as-is.
2. The `instruction` text is appended to the system prompt so the agent knows to call the tool.
3. After the agent finishes, the runner scans the tool call trace for a call matching `mcp__docs-mcp__<name>`.
4. Numeric metric fields are extracted from the tool call args. Missing or non-numeric fields are skipped (the result is still captured as long as at least one metric or the reasoning field has data).
5. Metrics are aggregated across scenarios in the eval summary as `feedbackMetrics`.

## Assertion Types

All assertion types support an optional `soft` flag:

| Field  | Type      | Required | Default | Description                                                                                                                                    |
| ------ | --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `soft` | `boolean` | no       | `false` | When `true`, the assertion is evaluated and shown in output (as yellow `⚠` on failure) but does **not** count toward the scenario's pass/fail |

Soft assertions are useful for typecheck or compilation checks that provide signal without blocking the overall result.

### `contains`

Checks if the agent's final answer includes the specified string (case-sensitive).

```json
{ "type": "contains", "value": "AcmeAuth" }
```

### `not_contains`

Checks that the agent's final answer does **not** include the specified string.

```json
{ "type": "not_contains", "value": "I don't know" }
```

### `matches`

Tests the agent's final answer against a regular expression.

```json
{
  "type": "matches",
  "pattern": "authorization.code|PKCE|refresh.token",
  "flags": "i"
}
```

| Field     | Type     | Required | Description                                    |
| --------- | -------- | -------- | ---------------------------------------------- |
| `pattern` | `string` | yes      | Regular expression body                        |
| `flags`   | `string` | no       | RegExp flags (e.g. `"i"` for case-insensitive) |

### `file_contains`

Reads a file in the agent's workspace and checks if it contains the specified string (case-sensitive). Fails with a clear message if the file doesn't exist.

```json
{ "type": "file_contains", "path": "solution.ts", "value": "AcmeAuth" }
```

| Field   | Type     | Required | Description                                   |
| ------- | -------- | -------- | --------------------------------------------- |
| `path`  | `string` | yes      | File path relative to the workspace directory |
| `value` | `string` | yes      | String to search for in the file content      |

### `file_matches`

Reads a file in the agent's workspace and tests its content against a regular expression. Fails with a clear message if the file doesn't exist.

```json
{
  "type": "file_matches",
  "path": "solution.ts",
  "pattern": "retryAfter|retry_after"
}
```

| Field     | Type     | Required | Description                                    |
| --------- | -------- | -------- | ---------------------------------------------- |
| `path`    | `string` | yes      | File path relative to the workspace directory  |
| `pattern` | `string` | yes      | Regular expression body                        |
| `flags`   | `string` | no       | RegExp flags (e.g. `"i"` for case-insensitive) |

### `script`

Runs a shell command in the agent's workspace directory. Passes if exit code is 0.

```json
{
  "type": "script",
  "command": "npx tsx solution.ts 2>&1 | grep -qi 'success'",
  "name": "runs-successfully",
  "when_env": "DUB_API_KEY"
}
```

| Field      | Type      | Required | Description                                                                                            |
| ---------- | --------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `command`  | `string`  | yes      | Shell command to execute (via `sh -c`)                                                                 |
| `name`     | `string`  | yes      | Human-readable label for the assertion                                                                 |
| `when_env` | `string`  | no       | Environment variable guard — if set but the variable is absent, the assertion is auto-passed (skipped) |
| `soft`     | `boolean` | no       | When `true`, failure is shown as `⚠` but doesn't affect scenario pass/fail                            |

The `when_env` field is useful for assertions that require API keys to run (e.g. actually executing generated code against a live SDK). In CI without the key, the assertion is skipped rather than failed.

Script assertions have a 30-second timeout.

## CLI Reference

```
docs-mcp-eval agent-eval [options]
```

### Scenario source (mutually exclusive, one required)

| Option               | Description                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `--suite <name>`     | Named scenario suite bundled with the eval package (resolves to `fixtures/agent-scenarios/<name>.yaml`) |
| `--scenarios <path>` | Path to a YAML/JSON scenario file (object keyed by ID, or legacy array)                                 |
| `--prompt <text>`    | Ad-hoc single scenario prompt (requires `--docs-dir`). Creates a one-off scenario with empty assertions |

### Filtering

| Option            | Description                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `--include <ids>` | Comma-separated scenario IDs to run (e.g. `--include ts-init,py-init`). Only matching scenarios are executed |

### Docs and server

| Option                     | Default           | Description                                                                            |
| -------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `--docs-dir <path>`        | —                 | Default docs directory for scenarios that don't specify their own `docsDir`/`docsSpec` |
| `--server-command <cmd>`   | _(auto-resolved)_ | Command to launch the MCP server                                                       |
| `--server-arg <value>`     | `[]`              | Repeatable server arguments                                                            |
| `--server-cwd <path>`      | —                 | Working directory for the server process                                               |
| `--server-env <key=value>` | `{}`              | Repeatable server environment variables                                                |

### Agent

| Option                    | Default                          | Description                                            |
| ------------------------- | -------------------------------- | ------------------------------------------------------ |
| `--provider <value>`      | `auto`                           | Agent provider: `anthropic`, `openai`, or `auto`       |
| `--model <value>`         | _(per-provider default)_         | Model to use (Anthropic default: `claude-opus-4-20250514`) |
| `--max-turns <n>`         | `15`                             | Default max turns per scenario                         |
| `--max-budget-usd <n>`    | `2.00`                           | Default max budget per scenario (USD)                  |
| `--max-concurrency <n>`   | `1`                              | Max concurrent scenarios                               |
| `--system-prompt <value>` | —                                | Custom system prompt for the agent                     |
| `--workspace-dir <path>`  | —                                | Base directory for agent workspaces                    |

### Mode

| Option      | Default | Description                                                             |
| ----------- | ------- | ----------------------------------------------------------------------- |
| `--no-mcp`  | —       | Run without docs-mcp server (baseline mode)                             |
| `--compare` | —       | Run with and without docs-mcp and compare results (mutually exclusive with `--no-mcp`) |

### Output

| Option              | Default | Description                                      |
| ------------------- | ------- | ------------------------------------------------ |
| `--out <path>`      | —       | Output JSON path                                 |
| `--no-save`         | —       | Skip auto-saving results to `.eval-results/`     |
| `--debug`           | `false` | Enable verbose agent event logging               |
| `--clean-workspace` | `false` | Delete workspace directories after run           |

## Comparison Mode (`--compare`)

The `--compare` flag automates an A/B comparison between an agent with docs-mcp tools and an agent without them. Instead of running two separate commands and mentally diffing the results, a single invocation handles both phases and produces a combined report.

### How it works

1. **Phase 1 (with MCP):** Builds indexes and runs all scenarios with docs-mcp tools available to the agent.
2. **Phase 2 (baseline):** Runs the same scenarios without any MCP server — the agent relies solely on its training knowledge.
3. **Comparison:** Pairs results by scenario ID, classifies each as `gained` (FAIL → PASS with MCP), `lost` (PASS → FAIL), `both_pass`, or `both_fail`, and prints a summary table with deltas.

### Usage

```bash
# Compare with and without docs-mcp on the value-add suite
docs-mcp-eval agent-eval --compare --suite acmeauth-value-add

# Run a single scenario in comparison mode
docs-mcp-eval agent-eval --compare --suite acmeauth-value-add --include webhook-events

# Save the full comparison JSON
docs-mcp-eval agent-eval --compare --suite acmeauth-value-add --out comparison.json
```

### Output

The comparison report (printed to stderr) includes:

- **Summary table:** Pass rate, avg turns, avg cost, total cost, and MCP calls — With MCP vs No MCP vs Delta
- **Scenario classification:** Count of gained, lost, both-pass, and both-fail scenarios
- **Flip details:** For scenarios that changed outcome, which specific assertions flipped between modes

When `--out` is set, the full `ComparisonOutput` JSON is written, containing both run outputs, per-scenario comparison results, and computed deltas.

When `--workspace-dir` is set, phases use isolated subdirectories (`with-mcp/` and `baseline/`) to avoid workspace collisions.

Both phases are auto-saved to `.eval-results/` under `<suite>` and `<suite>-baseline` respectively.

## Value-Add Scenario Suites

Two suites are designed specifically for `--compare` mode. Their scenarios test facts that are **only** findable in documentation — exact method names, class names, parameter names, and API-specific values. An agent without docs-mcp will hallucinate plausible but incorrect values; an agent with docs-mcp should find the exact values via `search_docs` / `get_doc`.

### `acmeauth-value-add` (synthetic docs)

Uses the bundled AcmeAuth test fixtures. No external dependencies or API keys needed.

| Scenario | What it tests | Key doc-dependent values |
|----------|---------------|--------------------------|
| `webhook-events` | Exact webhook event type names | `user.created`, `session.revoked`, `key.rotated`, `permission.changed` |
| `rate-limit-tiers` | Rate limits per plan tier | `60` (free), `6000` (enterprise), `X-RateLimit-Reset` |
| `jwt-claims` | JWT claims + JWKS endpoint | `aud`, `sub`, `.well-known`, `jwks` |
| `ts-webhook-sig` | TS SDK function + header name | `verifyWebhookSignature`, `x-acmeauth-signature`, `HMAC` |
| `py-error-classes` | Python SDK class/property names | `RateLimitError`, `retry_after`, `AcmeAuthError` |
| `retry-backoff` | Webhook retry timing sequence | `30 seconds`, `5 minutes`, `24 hours` |

### `dub-ts-value-add` (real SDK with typecheck)

Uses the real [Dub TypeScript SDK](https://github.com/dubinc/dub-ts) (`dub` on npm). Clones docs from GitHub and includes `tsc` typecheck assertions (soft) to validate that generated code compiles against real types.

| Scenario | What it tests | Key doc-dependent values |
|----------|---------------|--------------------------|
| `bulk-create` | Bulk link creation method name | `createMany` (not `bulkCreate`), `token` (not `apiKey`) |
| `error-handling` | Typed error classes + import path | `RateLimitExceeded` (not `RateLimitError`), `dub/models/errors`, `statusCode` |
| `track-sale` | Sale conversion tracking params | `track.sale`, `customerExternalId` (not `customerId`), `amount` |
| `geo-targeting` | Geo-targeted link creation | `geo` object with country codes (`US`, `GB`, `FR`) as keys |
| `analytics-timeseries` | Analytics retrieval method + enums | `analytics.retrieve`, `timeseries` groupBy, `30d` interval |
| `qr-code` | QR code generation method | `qrCodes.get`, `domain` + `key` parameters |

### Running value-add suites

```bash
# Synthetic docs (fast, no API key for docs)
mise agent-eval:compare acmeauth-value-add

# Real SDK with typecheck (clones repo, installs npm package)
mise agent-eval:compare dub-ts-value-add

# Single scenario smoke test
mise agent-eval:compare dub-ts-value-add -- --include bulk-create --debug
```

## Using from Another Repo

The eval framework works in two main contexts:

1. **Testing your own SDK docs quality** — point scenarios at your documentation to measure how well an AI agent can use them to complete tasks.
2. **Evaluating docs-mcp against any OSS project** — clone any project's docs via `docsSpec` to benchmark search and retrieval quality.

The only thing you need in a consumer repo is a scenario YAML file. Invoke the eval via npx:

```bash
# With Claude (default)
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.yaml

# With OpenAI Codex
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.yaml \
  --provider openai
```

### Pointing at an OSS project

Scenarios can use `docsSpec` to clone docs from any git repo, so no local docs checkout is needed:

```yaml
sdk-init:
  name: SDK init
  prompt: "Initialize the SDK client..."
  docsSpec:
    url: https://github.com/org/sdk-docs.git
    ref: v2.0
    docsPath: docs
  assertions:
    - type: contains
      value: Client
```

This works with any project that has markdown documentation — not just SDKs. For example, you could evaluate how well docs-mcp serves framework guides, API references, or operational runbooks.

### Using a local docs directory

Or point to a local docs directory with `--docs-dir`:

```bash
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.yaml \
  --docs-dir ./my-docs
```

When scenarios use `docsDir` or `docsSpec`, the CLI auto-resolves the MCP server command — no `--server-command` is needed.

### Portable JSON output

The `--out` flag produces a self-contained JSON artifact suitable for CI comparison:

```bash
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.yaml \
  --out eval-results.json
```

The eval also auto-saves results to `.eval-results/<suite>/` and compares against the most recent prior run. This trend comparison highlights regressions and improvements in pass rate, activation, turns, and cost.

## CI Integration

The recommended CI workflow runs the eval on both the base branch and the PR, then compares results:

1. **Run on base:** Check out the base branch, build, and run the eval with `--out base-results.json`
2. **Run on PR:** Check out the PR branch, build, and run the eval with `--out pr-results.json`
3. **Diff results:** Compare the two JSON files — the `summary` fields contain pass rate, activation rate, avg turns, and cost. Surface regressions as a PR comment.

The eval outputs structured JSON designed for this pattern. The `--out` flag writes a deterministic artifact, and the `history.ts` module provides `generateTrendSummary()` for local delta comparison.

```bash
# Example: run eval and save results for later comparison
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --suite my-sdk \
  --out eval-results.json

# The auto-saved results in .eval-results/ also work as a local baseline
# for trend tracking across development iterations.
```

## Result Format

Results are saved as JSON (auto-saved to `.eval-results/<suite>/` by default, or to `--out` if specified).

### Summary

```json
{
  "summary": {
    "totalScenarios": 10,
    "activationRate": 1.0,
    "passRate": 0.8,
    "avgTurns": 8.2,
    "medianTurns": 7,
    "avgCostUsd": 0.18,
    "totalCostUsd": 1.8,
    "avgDurationMs": 45000,
    "medianDurationMs": 42000,
    "avgInputTokens": 12000,
    "avgOutputTokens": 3500,
    "avgCacheReadInputTokens": 8000,
    "avgCacheCreationInputTokens": 4000,
    "toolUsageDistribution": {
      "mcp__docs-mcp__search_docs": 35,
      "mcp__docs-mcp__get_doc": 22
    },
    "feedbackMetrics": {
      "rating": 4.2
    },
    "categoryBreakdown": [
      {
        "category": "sdk-usage",
        "scenarioCount": 3,
        "activationRate": 1.0,
        "passRate": 1.0,
        "avgTurns": 6.3,
        "avgCostUsd": 0.14
      }
    ]
  }
}
```

| Metric                        | Description                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `activationRate`              | Fraction of scenarios where the agent called at least one docs-mcp tool (`search_docs` or `get_doc`) |
| `passRate`                    | Fraction of scenarios where all assertions passed                                                    |
| `avgTurns` / `medianTurns`    | Agent conversation turns (lower = more efficient)                                                    |
| `avgCostUsd` / `totalCostUsd` | API spend per scenario and total                                                                     |
| `toolUsageDistribution`       | Total calls per tool across all scenarios                                                            |
| `feedbackMetrics`             | Average feedback scores keyed by metric field name (only present if the agent called the feedback tool) |
| `categoryBreakdown`           | Per-category metrics (activation, pass rate, turns, cost)                                            |

### Per-Scenario Result

Each scenario result includes:

- `activated` — did the agent call any docs-mcp tool?
- `passed` — did all assertions pass?
- `assertionResults` — per-assertion pass/fail with messages
- `numTurns`, `totalCostUsd`, `durationMs` — performance metrics
- `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` — token usage
- `toolsCalled` — tool name → call count map
- `toolCallTrace` — ordered list of tool invocations with args, results, and timing
- `feedbackResult` — extracted feedback scores and reasoning (if the agent called the feedback tool)
- `finalAnswer` — the agent's last text response
- `resultSubtype` — `"success"`, `"error_max_turns"`, etc.

### Trend Comparison

When previous results exist in `.eval-results/`, the CLI automatically compares the current run against the most recent prior run and prints a delta table showing changes in pass rate, activation, avg turns, avg cost, and total cost. Per-scenario regressions and improvements are highlighted.

## Environment Variables

| Variable                               | Required | Description                                                                                          |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                    | \*       | API key for the Anthropic provider (used by `@anthropic-ai/claude-agent-sdk`)                        |
| `CLAUDE_CODE_USE_BEDROCK`             | \*       | Use AWS Bedrock as the Anthropic backend (alternative to `ANTHROPIC_API_KEY`)                         |
| `CLAUDE_CODE_USE_VERTEX`              | \*       | Use Google Vertex as the Anthropic backend (alternative to `ANTHROPIC_API_KEY`)                       |
| `OPENAI_API_KEY`                       | \*       | API key for the OpenAI Codex provider (also used for embedding-based index builds)                   |
| SDK-specific keys (e.g. `DUB_API_KEY`) | no       | For `script` assertions guarded by `when_env` — skipped if absent                                    |
| `NO_COLOR`                             | no       | Disables ANSI color output                                                                           |

\* At least one provider credential is required. With `--provider auto`, the eval detects which provider to use based on which key/variable is set.

### OpenAI Codex Prerequisites

The OpenAI Codex provider requires the [`codex`](https://github.com/openai/codex) CLI to be installed and available on PATH. Install it with:

```bash
npm install -g @openai/codex
```

The Codex CLI manages its own authentication. Run `codex` once interactively to authenticate, or set `OPENAI_API_KEY` in your environment.

When running from the monorepo via mise, copy `mise.local.toml.example` to `mise.local.toml` and fill in your API keys. The `.env` file in the eval package directory is also loaded automatically via `dotenv`.
