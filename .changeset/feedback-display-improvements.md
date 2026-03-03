---
"@speakeasy-api/docs-mcp-eval": minor
---

Add feedback display improvements, dub-ts-feedback fixture, and provider fixes

- Display feedback reasoning panel per-scenario as each completes
- Show headline feedback score in results table
- Prettify trend comparison panel with ANSI colors and box-drawing panels
- Add `dub-ts-feedback` built-in suite using real Dub TypeScript SDK
- Fix Claude provider tool result ID extraction (parent_tool_use_id fallback)
- Make `parseFeedbackResult` lenient — skips missing metrics instead of failing
- Increase default max turns to 100 and budget to $4
- Add feedback parser tests
