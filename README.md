# Pisama for TypeScript

Public source for Pisama's MIT-licensed TypeScript packages.

| Package | Purpose | Install |
|---|---|---|
| `@pisama/sdk` | AI SDK middleware, telemetry export, and PII redaction | `npm install @pisama/sdk` |
| `@pisama/detectors` | Local TypeScript failure detectors | `npm install @pisama/detectors` |
| `@pisama/cli` | Project setup, verification, MCP, and Harbor ATIF analysis | `npm install --global @pisama/cli` |

## Develop

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The packages run locally and do not require a Pisama account for local
detection. Hosted ingestion, dashboards, managed calibration, and paid
automation are separate Pisama services and are outside this repository.

Each package has its own README and version. Release workflows verify the tag,
build, type-check, and test the selected package before npm trusted publishing.

## License

MIT
