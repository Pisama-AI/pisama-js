#!/usr/bin/env bash
set -euo pipefail

release_dir=${1:-}
if [[ -z "$release_dir" ]]; then
  echo "usage: $0 <release-directory>" >&2
  exit 2
fi

mkdir -p "$release_dir"
release_dir=$(cd "$release_dir" && pwd -P)

# @pisama/sdk used to declare @pisama/detectors despite never importing it.
# Keep the removal provable in both source and the packed manifest: restoring
# that edge would make the SDK candidate needlessly depend on a separately
# staged version during installation.
if grep -RIEq --include='*.ts' --include='*.tsx' "from ['\"]@pisama/detectors|import\(['\"]@pisama/detectors" \
  packages/sdk/src; then
  echo '@pisama/sdk source unexpectedly imports @pisama/detectors' >&2
  exit 1
fi
if node -e "const p=require('./packages/sdk/package.json'); process.exit(p.dependencies?.['@pisama/detectors'] === undefined ? 0 : 1)"; then
  :
else
  echo '@pisama/sdk manifest unexpectedly declares @pisama/detectors' >&2
  exit 1
fi

pnpm --dir packages/detectors pack --pack-destination "$release_dir"
pnpm --dir packages/sdk pack --pack-destination "$release_dir"
pnpm --dir packages/cli pack --pack-destination "$release_dir"
pnpm --dir packages/whoopsie-detectors pack --pack-destination "$release_dir"
pnpm --dir packages/whoopsie-sdk pack --pack-destination "$release_dir"
pnpm --dir packages/whoopsie-cli pack --pack-destination "$release_dir"

expected_cli_version=$(node -p "require('./packages/cli/package.json').version")
AUDIT_CLI_ARTIFACT="${AUDIT_PACKED_CONSUMER:-0}" \
  ./scripts/verify-cli-artifact.sh \
  "$release_dir"/pisama-cli-*.tgz \
  "$expected_cli_version" \
  "$release_dir"/pisama-detectors-*.tgz

install_dir=$(mktemp -d)
legacy_extract=$(mktemp -d)
trap 'rm -rf -- "$install_dir" "$legacy_extract"' EXIT

npm install --ignore-scripts --prefix "$install_dir" \
  "$release_dir"/pisama-detectors-*.tgz
npm install --ignore-scripts --prefix "$install_dir" \
  "$release_dir"/pisama-sdk-*.tgz
npm install --ignore-scripts --prefix "$install_dir" \
  "$release_dir"/pisama-cli-*.tgz

# Install successor bytes first so npm resolves the retirement bridges against
# the exact local candidate versions rather than querying for versions that
# intentionally do not exist in the registry yet.
npm install --ignore-scripts --prefix "$install_dir" \
  "$release_dir"/whoopsie-detectors-*.tgz \
  "$release_dir"/whoopsie-sdk-*.tgz \
  "$release_dir"/whoopsie-cli-*.tgz

test -f "$install_dir/node_modules/@pisama/detectors/dist/index.d.ts"
test -f "$install_dir/node_modules/@pisama/sdk/dist/index.d.ts"
test -f "$install_dir/node_modules/@pisama/cli/THIRD_PARTY_NOTICES.md"
test -f "$install_dir/node_modules/@whoopsie/cli/LICENSE"
test -f "$install_dir/node_modules/@whoopsie/sdk/LICENSE"
test -f "$install_dir/node_modules/@whoopsie/detectors/LICENSE"
test "$("$install_dir/node_modules/.bin/pisama" --version)" = "$expected_cli_version"

set +e
whoopsie_output=$("$install_dir/node_modules/.bin/whoopsie" --help 2>&1)
whoopsie_status=$?
set -e
test "$whoopsie_status" = 1
grep -q '@whoopsie/cli is retired' <<< "$whoopsie_output"

(
  cd "$install_dir"
  EXPECTED_SDK_VERSION=$(node -p "require('./node_modules/@pisama/sdk/package.json').version") \
    node --input-type=module - <<'NODE'
const detectors = await import('@pisama/detectors');
const sdk = await import('@pisama/sdk');
const legacyDetectors = await import('@whoopsie/detectors');
const legacySdk = await import('@whoopsie/sdk');

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
if (legacyDetectors.runDetectors !== detectors.runDetectors) {
  throw new Error('packed @whoopsie/detectors does not exactly re-export its successor');
}
if (
  legacySdk.observe !== sdk.observe ||
  legacySdk.whoopsieMiddleware !== sdk.pisamaMiddleware
) {
  throw new Error('packed @whoopsie/sdk does not preserve its successor bridge aliases');
}

const expected = new Map([
  ['@pisama/cli', ['0.11.3', 'packages/cli']],
  ['@pisama/sdk', ['0.10.2', 'packages/sdk']],
  ['@pisama/detectors', ['0.10.1', 'packages/detectors']],
  ['@whoopsie/cli', ['0.9.0', 'packages/whoopsie-cli']],
  ['@whoopsie/sdk', ['0.9.0', 'packages/whoopsie-sdk']],
  ['@whoopsie/detectors', ['0.7.0', 'packages/whoopsie-detectors']],
]);
for (const [name, [version, directory]] of expected) {
  const manifest = await import(`${name}/package.json`, { with: { type: 'json' } })
    .then((module) => module.default)
    .catch(async () => {
      const { readFile } = await import('node:fs/promises');
      return JSON.parse(
        await readFile(new URL(`node_modules/${name}/package.json`, `file://${process.cwd()}/`)),
      );
    });
  if (manifest.version !== version) throw new Error(`${name} version mismatch`);
  if (manifest.repository?.url !== 'https://github.com/Pisama-AI/pisama-js') {
    throw new Error(`${name} repository URL is not the public canonical source`);
  }
  if (manifest.repository?.directory !== directory) {
    throw new Error(`${name} repository.directory mismatch`);
  }
  if (
    manifest.publishConfig?.access !== 'public' ||
    manifest.publishConfig?.registry !== 'https://registry.npmjs.org'
  ) {
    throw new Error(`${name} does not force public publication through the official registry`);
  }
  for (const spec of Object.values(manifest.dependencies ?? {})) {
    if (String(spec).startsWith('workspace:')) {
      throw new Error(`${name} leaked a workspace dependency into its tarball`);
    }
  }
  if (name === '@pisama/sdk' && manifest.dependencies?.['@pisama/detectors'] !== undefined) {
    throw new Error('@pisama/sdk packed manifest restored its unused detector dependency');
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (manifest.scripts?.[lifecycle]) throw new Error(`${name} ships ${lifecycle}`);
  }
}
NODE
)

for artifact in "$release_dir"/*.tgz; do
  rm -rf -- "$legacy_extract/package"
  tar -xzf "$artifact" -C "$legacy_extract"

  if grep -RIEq 'whoopsie[.]dev|pisama[.]ai/live|/api/v1/spans' "$legacy_extract/package"; then
    echo "artifact contains a retired host or removed route: $artifact" >&2
    exit 1
  fi

  # Every shipped JS/config authorization assignment must use the scoped JWT
  # variable named `token`. This catches a regression back to raw-key Bearer
  # (or direct raw-key Authorization) without rejecting the token-exchange
  # JSON body, where the API key is expected to appear.
  node - "$legacy_extract/package" <<'NODE'
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { extname, join } = require('node:path');

const root = process.argv[2];
const extensions = new Set(['.js', '.cjs', '.mjs', '.json']);
function visit(path) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) visit(join(path, entry));
    return;
  }
  if (!extensions.has(extname(path)) || path.endsWith('.js.map')) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/authorization/i.test(line)) continue;
    if (!/Bearer \$\{token\}/.test(line) || /apiKey|PISAMA_API_KEY/.test(line)) {
      throw new Error(`${path}:${index + 1}: unreviewed authorization assignment`);
    }
  }
}
visit(root);
NODE
done

for artifact in "$release_dir"/whoopsie-*.tgz; do
  rm -rf -- "$legacy_extract/package"
  tar -xzf "$artifact" -C "$legacy_extract"
  if grep -RIEq 'authorization.{0,20}Bearer|fetch\(|node:https|node:http' \
    "$legacy_extract/package"; then
    echo "legacy artifact contains an undeclared transport: $artifact" >&2
    exit 1
  fi
done

if [[ "${AUDIT_PACKED_CONSUMER:-0}" == "1" ]]; then
  npm audit --omit=dev --audit-level=moderate --prefix "$install_dir"
fi
