# @speakeasy-api/docs-mcp-eval

## 0.14.0

### Patch Changes

- Updated dependencies [f591bfe]
  - @speakeasy-api/docs-mcp-core@0.14.0
  - @speakeasy-api/docs-mcp-cli@0.14.0

## 0.13.0

### Patch Changes

- 7305f3e: Fix eval usage reporting to fall back to accumulated counts when SDK final values are zero
  - Prefer SDK-reported final usage values but fall back to incrementally accumulated counts when they are zero
  - Add debug logging for Claude provider result and runner done events

- Updated dependencies [8a321c5]
  - @speakeasy-api/docs-mcp-core@0.13.0
  - @speakeasy-api/docs-mcp-cli@0.13.0

## 0.12.1

### Patch Changes

- 19fc61f: Fix CLI resolution when installed from npm

  Resolve the CLI entry point via `import.meta.resolve` instead of a hardcoded relative path (`../cli/dist/index.js`) that only works inside the monorepo. Adds `@speakeasy-api/docs-mcp-cli` as a dependency so the module resolver can find it in both monorepo and published contexts.

- 8ad7ffa: Improve agent eval resiliency and parameterization
  - Skip scenarios that fail due to infrastructure errors (API overload/529) instead of counting them as test failures
  - Exclude skipped scenarios from pass rate calculations
  - Fix double-counting of token usage when assistant messages contain multiple text blocks
  - Bump default max-turns to 100 and max-budget-usd to 5.00
  - Allow suite config files to specify `system_prompt` and per-scenario `maxTurns`/`maxBudgetUsd` overrides
  - Update default model to claude-opus-4-6
  - @speakeasy-api/docs-mcp-core@0.12.1
  - @speakeasy-api/docs-mcp-cli@0.12.1

## 0.12.0

### Minor Changes

- 99822b0: Add feedback display improvements, dub-ts-feedback fixture, and provider fixes
  - Display feedback reasoning panel per-scenario as each completes
  - Show headline feedback score in results table
  - Prettify trend comparison panel with ANSI colors and box-drawing panels
  - Add `dub-ts-feedback` built-in suite using real Dub TypeScript SDK
  - Fix Claude provider tool result ID extraction (parent_tool_use_id fallback)
  - Make `parseFeedbackResult` lenient — skips missing metrics instead of failing
  - Increase default max turns to 100 and budget to $4
  - Add feedback parser tests

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.12.0

## 0.11.0

### Minor Changes

- c61ced6: Add tool usage bar chart and feedback tool confidence scoring to agent eval
  - **Tool usage bar chart**: Terminal ASCII bar chart in eval summary showing full tool call distribution (not just MCP tools), with colored bars sorted by count
  - **Feedback tool**: New `--feedback-tool` flag on the server registers a `docs_feedback` tool that agents call to self-report confidence, relevance, and utilization scores (0-100)
  - **Judge mode** (default on): Agent eval automatically enables feedback tool, instructs the agent to call it, extracts scores from tool trace, and displays them in scenario results, summary, and comparison reports. Disable with `--no-judge`

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.11.0

## 0.10.0

### Minor Changes

- ce7cdb8: Add `links` field to agent scenarios for symlinking repo directories into agent workspaces

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.10.0

## 0.9.0

### Minor Changes

- ab58343: Add YAML scenario support, rename provider "claude" to "anthropic", and replace per-scenario `model` with provider-keyed `models`

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.9.0

## 0.8.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.8.0

## 0.7.0

### Minor Changes

- bb9e8d6: Added support for setting MCP server instructions using the manifest. It is collected at build time and exposed when MCP clients call the initialize RPC method against the server.

### Patch Changes

- de3f4c9: Fixed lint and test errors
- Updated dependencies [bb9e8d6]
- Updated dependencies [de3f4c9]
  - @speakeasy-api/docs-mcp-core@0.7.0

## 0.6.0

### Minor Changes

- 4f93b52: Added support for exposing documents as MCP resources that can be added into agent context.

### Patch Changes

- Updated dependencies [4f93b52]
  - @speakeasy-api/docs-mcp-core@0.6.0

## 0.5.0

### Minor Changes

- 0678460: Add multi-provider agent eval support with OpenAI Codex as a second provider. Introduces `AgentProvider` interface, `--provider` CLI flag, MCP pre-flight verification, and cost/token tracking for Codex. Removes hardcoded system prompts from acmeauth fixtures and adds package.json dependency assertions.

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.5.0

## 0.4.2

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.2

## 0.4.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.1

## 0.4.0

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.4.0

## 0.3.0

### Minor Changes

- 029ec37: Add agent evaluation harness for end-to-end testing of MCP tool usage

  Introduces a self-contained agent eval framework that uses Claude Agent SDK to run realistic coding scenarios against docs-mcp, with assertion-based scoring, file content validation, and an interactive CLI (`docs-mcp-eval`). Includes multi-language scenarios for several SDKs, build caching, history tracking, and configurable tool descriptions in the server.

### Patch Changes

- Updated dependencies [029ec37]
  - @speakeasy-api/docs-mcp-core@0.3.0

## 0.2.1

### Patch Changes

- @speakeasy-api/docs-mcp-core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [2d6675d]
- Updated dependencies [df2c538]
- Updated dependencies [9998fcd]
  - @speakeasy-api/docs-mcp-core@0.2.0
