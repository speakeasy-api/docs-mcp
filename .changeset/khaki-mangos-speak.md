---
"@speakeasy-api/docs-mcp-server": patch
---

Register SIGINT and SIGTERM handlers so the server closes its active transport before exiting. This lets HTTP and stdio deployments stop cleanly in containers instead of hanging on shutdown.
