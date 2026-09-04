# @whoopsie/sdk retirement bridge

This package name is retired. Version 0.9.0 is a zero-logic compatibility
bridge to `@pisama/sdk@0.10.2`. It contains no exporter, endpoint, credential
handling, or other network implementation of its own. The former
`whoopsieMiddleware` value and `WhoopsieMiddlewareOptions` type are preserved
as aliases of their `pisamaMiddleware` successors during migration.

New code should depend on and import `@pisama/sdk` directly. Existing code can
temporarily upgrade this package to 0.9.0 while changing imports, but the
bridge is not a permanent compatibility line.

The successor requires `PISAMA_API_KEY` in the server runtime and exchanges it
for a scoped token before authenticated OTLP ingest. See the successor package
README for its supported AI SDK peer versions and privacy controls.

Versions below 0.9.0 remain historical, network-capable bytes. This bridge is
an opt-in breaking-line migration and does not silently replace pinned or
caret consumers on older major-zero ranges.
