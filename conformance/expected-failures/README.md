# Conformance expected failures

`scripts/conformance.ts` runs the official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
against a docs-mcp server built from this checkout, once per spec revision listed here and
once per HTTP mode (stateless and sessions), using the `--requirements <revision>` set the
suite defines for that revision.

Each `<revision>.txt` lists the scenarios expected to fail for that revision, one per line
with a `# reason`. Most entries exist because the suite exercises the reference "everything"
server's fixtures (specific prompt names, `test:` resource URIs, tools that return images or
audio, sampling, elicitation) rather than the documentation tools this server exposes. A
scenario that fails without an entry fails the run; a scenario that starts passing is
reported so its entry can be removed.

```sh
mise run conformance                                                  # every revision, both modes
node scripts/conformance.ts --requirements 2026-07-28 --mode stateless
```
