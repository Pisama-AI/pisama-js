#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:-}
if [[ -z "$release_dir" ]]; then
  echo "usage: $0 <release-directory>" >&2
  exit 2
fi

mkdir -p "$release_dir"
pnpm --dir packages/detectors pack --pack-destination "$release_dir"
pnpm --dir packages/sdk pack --pack-destination "$release_dir"
pnpm --dir packages/cli pack --pack-destination "$release_dir"

install_dir=$(mktemp -d)
trap 'rm -rf -- "$install_dir"' EXIT

npm install --ignore-scripts --prefix "$install_dir" \
  "$release_dir"/pisama-detectors-*.tgz \
  "$release_dir"/pisama-sdk-*.tgz \
  "$release_dir"/pisama-cli-*.tgz

test -f "$install_dir/node_modules/@pisama/detectors/dist/index.d.ts"
test -f "$install_dir/node_modules/@pisama/sdk/dist/index.d.ts"
test -f "$install_dir/node_modules/@pisama/cli/THIRD_PARTY_NOTICES.md"

expected_cli_version=$(node -p "require('./packages/cli/package.json').version")
test "$("$install_dir/node_modules/.bin/pisama" --version)" = "$expected_cli_version"

(
  cd "$install_dir"
  EXPECTED_SDK_VERSION=$(node -p "require('./node_modules/@pisama/sdk/package.json').version") \
    node --input-type=module - <<'NODE'
const detectors = await import('@pisama/detectors');
const sdk = await import('@pisama/sdk');

if (typeof detectors.runDetectors !== 'function' || !Array.isArray(detectors.v1Detectors)) {
  throw new Error('packed @pisama/detectors public API is incomplete');
}

const hits = detectors.runDetectors({
  traceId: 'packed-consumer-smoke',
  startTime: 0,
  toolCalls: Array.from({ length: 7 }, (_, index) => ({
    toolName: 'search',
    startTime: index,
  })),
});
if (!hits.some((hit) => hit.detector === 'loop' && hit.detected)) {
  throw new Error('packed @pisama/detectors did not execute its public detector API');
}

const multiAgentOperations = Object.keys(detectors.createMultiAgentDetectors()).sort();
if (JSON.stringify(multiAgentOperations) !== JSON.stringify(['coordination', 'persona'])) {
  throw new Error(`packed multi-agent API exposes unsupported operations: ${multiAgentOperations}`);
}

if (typeof sdk.observe !== 'function' || sdk.SDK_VERSION !== process.env.EXPECTED_SDK_VERSION) {
  throw new Error('packed @pisama/sdk public API or version is incomplete');
}
NODE
)

if [[ "${AUDIT_PACKED_CONSUMER:-0}" == "1" ]]; then
  npm audit --omit=dev --audit-level=moderate --prefix "$install_dir"
fi
