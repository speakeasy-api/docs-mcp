# Agent Evaluation Framework (`agent-eval`)

The `agent-eval` subcommand of `@speakeasy-api/docs-mcp-eval` runs end-to-end agent evaluations. It spawns a Claude agent with docs-mcp tools (`search_docs`, `get_doc`), runs it against a prompt, and evaluates assertions on the output. This validates the full stack — from search quality to how well a real model uses the tools to complete a task.

## Scenario Format

A scenario file is a JSON array of `AgentScenario` objects:

```json
[
  {
    "name": "Initialize the TypeScript client",
    "prompt": "Using the AcmeAuth TypeScript SDK, write a script in solution.ts that initializes the client with an API key and fetches a user by ID. Use the docs-mcp tools to look up the correct SDK usage.",
    "description": "AcmeAuth SDK — multi-language authentication client",
    "docsDir": "./docs",
    "category": "sdk-usage",
    "systemPrompt": "You are an expert developer. Always use the docs-mcp tools to look up SDK usage.",
    "setup": "npm init -y --silent 2>/dev/null",
    "maxTurns": 15,
    "maxBudgetUsd": 0.50,
    "assertions": [
      { "type": "contains", "value": "AcmeAuth" },
      { "type": "script", "command": "test -f solution.ts", "name": "file-exists" },
      { "type": "script", "command": "grep -q 'apiKey' solution.ts", "name": "uses-api-key" }
    ]
  }
]
```

### Field Reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes | — | Human-readable scenario name, used in output tables and result keys |
| `prompt` | `string` | yes | — | The user prompt sent to the Claude agent |
| `assertions` | `AgentAssertion[]` | yes | — | Array of assertions to evaluate against the agent's output |
| `category` | `string` | no | — | Grouping tag for per-category breakdown (e.g. `"sdk-usage"`, `"error-handling"`) |
| `maxTurns` | `number` | no | `15` | Max agent conversation turns for this scenario |
| `maxBudgetUsd` | `number` | no | `0.50` | Max dollar spend for this scenario |
| `systemPrompt` | `string` | no | — | System prompt given to the agent |
| `setup` | `string` | no | — | Shell command run in the workspace directory before the agent starts |
| `description` | `string` | no | — | Corpus description for the docs index; flows into MCP tool descriptions |
| `docsSpec` | `DocsRepoSpec` | no | — | Git repo to clone and index docs from (takes precedence over `docsDir`) |
| `docsDir` | `string` | no | — | Path to a local docs directory, resolved relative to the scenario file |

A scenario **passes** only if it has at least one assertion and all assertions pass.

## Docs Sources

Each scenario needs a documentation corpus. There are two ways to specify one:

### `docsDir` — Local Path

Point to a local docs directory. The path is resolved relative to the scenario file's location.

```json
{
  "docsDir": "../../my-docs"
}
```

### `docsSpec` — Clone from Git

Clone a repository and index a subdirectory within it. Useful for evaluating against external SDK documentation.

```json
{
  "docsSpec": {
    "url": "https://github.com/org/sdk-docs.git",
    "ref": "main",
    "docsPath": "docs/typescript",
    "docsConfig": {
      "version": "1",
      "strategy": { "chunk_by": "h2" },
      "metadata": { "language": "typescript" }
    }
  }
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | yes | — | Git clone URL |
| `ref` | `string` | no | `"main"` | Branch, tag, or commit |
| `docsPath` | `string` | no | `"."` | Subdirectory within the repo containing docs |
| `docsConfig` | `object` | no | — | Inline `.docs-mcp.json` manifest (written into the docs directory if the repo lacks one) |

### Auto-Build and Caching

The CLI automatically builds a search index for each docs source before running scenarios. Indexes are cached at `.cache/indexes/` keyed by a content hash of the docs directory (file paths, sizes, mtimes, and any `.docs-mcp.json` contents). If the docs haven't changed, the cached index is reused.

For `docsSpec` scenarios, cloned repositories are cached at `.cache/repos/` keyed by a hash of `url + ref`. A `.clone-complete` marker prevents re-cloning on subsequent runs.

Multiple scenarios sharing the same docs directory and description share a single index build.

## Assertion Types

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
{ "type": "matches", "pattern": "authorization.code|PKCE|refresh.token", "flags": "i" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | yes | Regular expression body |
| `flags` | `string` | no | RegExp flags (e.g. `"i"` for case-insensitive) |

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

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | yes | Shell command to execute (via `sh -c`) |
| `name` | `string` | yes | Human-readable label for the assertion |
| `when_env` | `string` | no | Environment variable guard — if set but the variable is absent, the assertion is auto-passed (skipped) |

The `when_env` field is useful for assertions that require API keys to run (e.g. actually executing generated code against a live SDK). In CI without the key, the assertion is skipped rather than failed.

Script assertions have a 30-second timeout.

## CLI Reference

```
docs-mcp-eval agent-eval [options]
```

### Scenario source (mutually exclusive, one required)

| Option | Description |
|---|---|
| `--suite <name>` | Named scenario suite bundled with the eval package (resolves to `fixtures/agent-scenarios/<name>.json`) |
| `--scenarios <path>` | Path to a JSON file containing an array of `AgentScenario` objects |
| `--prompt <text>` | Ad-hoc single scenario prompt (requires `--docs-dir`). Creates a one-off scenario with empty assertions |

### Docs and server

| Option | Default | Description |
|---|---|---|
| `--docs-dir <path>` | — | Default docs directory for scenarios that don't specify their own `docsDir`/`docsSpec` |
| `--server-command <cmd>` | *(auto-resolved)* | Command to launch the MCP server |
| `--server-arg <value>` | `[]` | Repeatable server arguments |
| `--server-cwd <path>` | — | Working directory for the server process |
| `--server-env <key=value>` | `{}` | Repeatable server environment variables |

### Agent

| Option | Default | Description |
|---|---|---|
| `--model <value>` | `claude-sonnet-4-20250514` | Claude model to use |
| `--max-turns <n>` | `15` | Default max turns per scenario |
| `--max-budget-usd <n>` | `0.50` | Default max budget per scenario (USD) |
| `--max-concurrency <n>` | `1` | Max concurrent scenarios |
| `--system-prompt <value>` | — | Custom system prompt for the agent |
| `--workspace-dir <path>` | — | Base directory for agent workspaces |

### Output

| Option | Default | Description |
|---|---|---|
| `--out <path>` | — | Output JSON path |
| `--no-save` | — | Skip auto-saving results to `.eval-results/` |
| `--debug` | `false` | Keep workspaces after run for inspection |

## Using from Another Repo

The only thing you need in a consumer repo is a scenario JSON file. Invoke the eval via npx:

```bash
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.json \
  --model claude-sonnet-4-20250514
```

Scenarios can use `docsSpec` to clone docs from any git repo, so no local docs checkout is needed:

```json
[
  {
    "name": "SDK init",
    "prompt": "Initialize the SDK client...",
    "docsSpec": {
      "url": "https://github.com/org/sdk-docs.git",
      "ref": "v2.0",
      "docsPath": "docs"
    },
    "assertions": [
      { "type": "contains", "value": "Client" }
    ]
  }
]
```

Or point to a local docs directory with `--docs-dir`:

```bash
npx @speakeasy-api/docs-mcp-eval agent-eval \
  --scenarios ./agent-scenarios.json \
  --docs-dir ./my-docs
```

When scenarios use `docsDir` or `docsSpec`, the CLI auto-resolves the MCP server command — no `--server-command` is needed.

## Result Format

Results are saved as JSON (auto-saved to `.eval-results/<suite>/` by default, or to `--out` if specified).

### Summary

```json
{
  "summary": {
    "totalScenarios": 10,
    "activationRate": 1.0,
    "passRate": 0.80,
    "avgTurns": 8.2,
    "medianTurns": 7,
    "avgCostUsd": 0.18,
    "totalCostUsd": 1.80,
    "avgDurationMs": 45000,
    "medianDurationMs": 42000,
    "avgInputTokens": 12000,
    "avgOutputTokens": 3500,
    "toolUsageDistribution": {
      "mcp__docs-mcp__search_docs": 35,
      "mcp__docs-mcp__get_doc": 22
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

| Metric | Description |
|---|---|
| `activationRate` | Fraction of scenarios where the agent called at least one docs-mcp tool (`search_docs` or `get_doc`) |
| `passRate` | Fraction of scenarios where all assertions passed |
| `avgTurns` / `medianTurns` | Agent conversation turns (lower = more efficient) |
| `avgCostUsd` / `totalCostUsd` | API spend per scenario and total |
| `toolUsageDistribution` | Total calls per tool across all scenarios |
| `categoryBreakdown` | Per-category metrics (activation, pass rate, turns, cost) |

### Per-Scenario Result

Each scenario result includes:

- `activated` — did the agent call any docs-mcp tool?
- `passed` — did all assertions pass?
- `assertionResults` — per-assertion pass/fail with messages
- `numTurns`, `totalCostUsd`, `durationMs` — performance metrics
- `toolsCalled` — tool name → call count map
- `toolCallTrace` — ordered list of tool invocations with args, results, and timing
- `finalAnswer` — the agent's last text response
- `resultSubtype` — `"success"`, `"error_max_turns"`, etc.

### Trend Comparison

When previous results exist in `.eval-results/`, the CLI automatically compares the current run against the most recent prior run and prints a delta table showing changes in pass rate, activation, avg turns, avg cost, and total cost. Per-scenario regressions and improvements are highlighted.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | **yes** | API key for the Claude agent (used by `@anthropic-ai/claude-agent-sdk`) |
| `OPENAI_API_KEY` | no | For embedding-based index builds (when using OpenAI embeddings) |
| SDK-specific keys (e.g. `DUB_API_KEY`) | no | For `script` assertions guarded by `when_env` — skipped if absent |
| `NO_COLOR` | no | Disables ANSI color output |

The `.env` file in the eval package directory is loaded automatically via `dotenv`.
