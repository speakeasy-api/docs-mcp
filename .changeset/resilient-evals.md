---
"@speakeasy-api/docs-mcp-eval": patch
---

Improve agent eval resiliency and parameterization

- Skip scenarios that fail due to infrastructure errors (API overload/529) instead of counting them as test failures
- Exclude skipped scenarios from pass rate calculations
- Fix double-counting of token usage when assistant messages contain multiple text blocks
- Bump default max-turns to 100 and max-budget-usd to 5.00
- Allow suite config files to specify `system_prompt` and per-scenario `maxTurns`/`maxBudgetUsd` overrides
- Update default model to claude-opus-4-6
