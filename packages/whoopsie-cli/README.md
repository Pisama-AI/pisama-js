# @whoopsie/cli retirement release

This package is retired. Version 0.9.0 is a no-network tombstone: every
invocation exits non-zero after printing a migration message. It does not
modify a repository, open a browser, or contact an API.

Both the historical `pisama-ts` executable and the `whoopsie` alias run that
tombstone, so an explicit upgrade cannot silently retain the old transport.

Use `@pisama/cli@0.11.3` or newer. The command name is `pisama` (with
`pisama-ts` retained as an alias):

```bash
npx --yes --package=@pisama/cli@0.11.3 -- pisama --help
```

The replacement requires `PISAMA_API_KEY` for hosted verification, ATIF
analysis, and MCP reads. Keep that key in the server environment rather than
passing it through shared shell history.

Versions below 0.9.0 remain historical, network-capable bytes. They are not
made inert by this opt-in breaking-line release; follow the registry
deprecation and historical-host containment guidance from the migration
runbook.
