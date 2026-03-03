---
"@speakeasy-api/docs-mcp-server": minor
"@speakeasy-api/docs-mcp-eval": minor
---

Add tool usage bar chart and feedback tool confidence scoring to agent eval

- **Tool usage bar chart**: Terminal ASCII bar chart in eval summary showing full tool call distribution (not just MCP tools), with colored bars sorted by count
- **Feedback tool**: New `--feedback-tool` flag on the server registers a `docs_feedback` tool that agents call to self-report confidence, relevance, and utilization scores (0-100)
- **Judge mode** (default on): Agent eval automatically enables feedback tool, instructs the agent to call it, extracts scores from tool trace, and displays them in scenario results, summary, and comparison reports. Disable with `--no-judge`
