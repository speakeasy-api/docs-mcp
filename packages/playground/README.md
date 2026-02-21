# @speakeasy-api/docs-mcp-playground

Interactive web playground for demonstrating and exploring a [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp) server.

**Beta.** Part of the [Speakeasy Docs MCP](https://github.com/speakeasy-api/docs-mcp) monorepo.

## Installation

```bash
npm install -g @speakeasy-api/docs-mcp-playground
```

## Usage

Point the playground at a running `docs-mcp-server` instance:

```bash
MCP_TARGET=http://localhost:20310 docs-mcp-playground
```

Then open `http://localhost:3001` in your browser.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port the playground server listens on |
| `MCP_TARGET` | `http://localhost:20310` | URL of the docs-mcp-server to proxy MCP requests to |
| `PLAYGROUND_PASSWORD` | _(none)_ | If set, enables password authentication |
| `SERVER_NAME` | `speakeasy-docs` | Display name shown in the playground UI |

## License

[AGPL-3.0](https://github.com/speakeasy-api/docs-mcp/blob/main/LICENSE)
