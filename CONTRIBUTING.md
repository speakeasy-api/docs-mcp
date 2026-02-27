# Contributing to Speakeasy Docs MCP

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** 10.5.2+ (the repo uses `packageManager` to enforce this)

## Getting Started

```bash
# Clone the repository
git clone https://github.com/speakeasy-api/docs-mcp.git
cd docs-mcp

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Repository Structure

This is a Turborepo monorepo with the following packages:

| Package               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `packages/core`       | Core indexing, chunking, and search engine        |
| `packages/server`     | MCP server runtime (stdio and HTTP transports)    |
| `packages/cli`        | CLI for manifest bootstrapping and index building |
| `packages/eval`       | Evaluation and benchmarking harness               |
| `packages/playground` | Interactive web playground                        |

## Development Workflow

### Building

```bash
pnpm build          # Build all packages (uses Turbo caching)
pnpm typecheck      # Type-check without emitting
pnpm lint           # Run ESLint across all packages
```

### Testing

```bash
pnpm test           # Run all tests
```

Tests use [Vitest](https://vitest.dev/). Each package has its own `test/` directory.

### Running Locally

The project includes [mise](https://mise.jdx.dev/) tasks for common workflows:

```bash
mise run serve:http      # Start HTTP MCP server on port 20310
mise run playground      # Start the interactive playground
mise run inspect:http    # Open MCP Inspector
```

## Submitting Changes

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, ensuring `pnpm build`, `pnpm test`, and `pnpm lint` all pass.
3. Write clear, concise commit messages.
4. Open a pull request against `main` with a description of what changed and why.

## Reporting Issues

Open an issue on GitHub with:

- A clear description of the problem or suggestion.
- Steps to reproduce (for bugs).
- Expected vs. actual behavior.

## Contributor License Agreement

By submitting a pull request or otherwise contributing to this project, you agree to the following terms:

1. **Grant of Rights.** You grant Speakeasy API, Inc. ("Speakeasy") a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, sublicense, relicense, distribute, and otherwise exploit your contributions in any form and for any purpose, including under licenses other than the AGPL-3.0.

2. **Original Work.** You represent that your contributions are your original work and that you have the legal right to grant this license. If your employer has rights to intellectual property you create, you represent that you have received permission to make the contribution on behalf of your employer, or that your employer has waived such rights.

3. **No Obligation.** You understand that Speakeasy is under no obligation to accept or include your contribution in the project.

4. **Project License.** This project is distributed under the [AGPL-3.0](LICENSE) license. Your contributions will be made available under the same license unless Speakeasy exercises its right to relicense as described above.
