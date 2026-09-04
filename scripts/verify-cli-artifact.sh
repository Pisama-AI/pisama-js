#!/usr/bin/env bash
set -euo pipefail

artifact=${1:-}
expected_version=${2:-}
detectors_artifact=${3:-}
max_tarball_bytes=${MAX_CLI_TARBALL_BYTES:-200000}

if [[ -z "$artifact" || -z "$expected_version" || -z "$detectors_artifact" ]]; then
  echo "usage: $0 <cli-tarball> <expected-version> <detectors-tarball>" >&2
  exit 2
fi
if [[ ! -f "$artifact" ]]; then
  echo "CLI tarball not found: $artifact" >&2
  exit 2
fi
if [[ ! -f "$detectors_artifact" ]]; then
  echo "Detectors tarball not found: $detectors_artifact" >&2
  exit 2
fi
artifact_dir=$(cd -- "$(dirname -- "$artifact")" && pwd -P)
artifact="$artifact_dir/$(basename -- "$artifact")"
detectors_dir=$(cd -- "$(dirname -- "$detectors_artifact")" && pwd -P)
detectors_artifact="$detectors_dir/$(basename -- "$detectors_artifact")"

tarball_bytes=$(wc -c < "$artifact" | tr -d ' ')
if (( tarball_bytes > max_tarball_bytes )); then
  echo "CLI tarball is ${tarball_bytes} bytes; budget is ${max_tarball_bytes} bytes" >&2
  exit 1
fi

archive_entries=$(tar -tzf "$artifact")
for required in \
  package/package.json \
  package/README.md \
  package/LICENSE \
  package/CHANGELOG.md \
  package/THIRD_PARTY_NOTICES.md \
  package/dist/bin.js \
  package/dist/mcp.js \
  package/dist/platform-auth.js
do
  if ! grep -qx "$required" <<< "$archive_entries"; then
    echo "CLI tarball is missing $required" >&2
    exit 1
  fi
done

if unexpected_entries=$(grep -Ev \
  '^package/(package\.json|README\.md|LICENSE|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md|dist/(analyze-atif|bin|init|mcp|patch|platform-auth|verify)\.(js|js\.map|d\.ts|d\.ts\.map))$' \
  <<< "$archive_entries")
then
  echo "CLI tarball contains unexpected files:" >&2
  echo "$unexpected_entries" >&2
  exit 1
fi

install_dir=$(mktemp -d)
consumer_dir=$(mktemp -d)
artifact_extract=$(mktemp -d)
trap 'rm -rf -- "$install_dir" "$consumer_dir" "$artifact_extract"' EXIT

tar -xzf "$artifact" -C "$artifact_extract"
expected_fast_uri=$(node -p "require('./package.json').pnpm.overrides['fast-uri']")
if ! grep -Fq -- "\`fast-uri\` ${expected_fast_uri}," \
  "$artifact_extract/package/THIRD_PARTY_NOTICES.md"; then
  echo "CLI notice does not match pinned fast-uri ${expected_fast_uri}" >&2
  exit 1
fi
if grep -RIEq 'whoopsie[.]dev|pisama[.]ai/live|/api/v1/spans' "$artifact_extract/package"; then
  echo 'CLI artifact retains a retired host or removed route reference' >&2
  exit 1
fi

npm install --ignore-scripts --prefix "$install_dir" "$detectors_artifact"
npm install --ignore-scripts --prefix "$install_dir" "$artifact"

node --input-type=module - "$install_dir" "$expected_version" <<'NODE'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const installDir = process.argv[2];
const expectedVersion = process.argv[3];
const packagePath = join(installDir, 'node_modules', '@pisama', 'cli', 'package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

const expected = {
  name: '@pisama/cli',
  version: expectedVersion,
  license: 'MIT',
  node: '>=20',
  repository: 'https://github.com/Pisama-AI/pisama-js',
  registry: 'https://registry.npmjs.org',
};

for (const [field, actual] of Object.entries({
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  node: pkg.engines?.node,
  repository: pkg.repository?.url,
  registry: pkg.publishConfig?.registry,
})) {
  if (actual !== expected[field]) {
    throw new Error(`packed metadata mismatch for ${field}: ${String(actual)}`);
  }
}
if (pkg.publishConfig?.access !== 'public') {
  throw new Error('packed package does not enforce public npm access');
}
if (pkg.bin?.pisama !== './dist/bin.js' || pkg.bin?.['pisama-ts'] !== './dist/bin.js') {
  throw new Error('packed package does not expose both documented command names');
}
if ('@modelcontextprotocol/sdk' in (pkg.dependencies ?? {})) {
  throw new Error('packed package reintroduced the unbundled MCP dependency tree');
}
NODE

for command in pisama pisama-ts; do
  test "$("$install_dir/node_modules/.bin/$command" --version)" = "$expected_version"
  "$install_dir/node_modules/.bin/$command" --help >/dev/null
done

npm install --ignore-scripts --prefix "$consumer_dir" "$detectors_artifact"
npm install --ignore-scripts --prefix "$consumer_dir" "$artifact"
documented_version=$(npm exec --prefix "$consumer_dir" -- pisama-ts --version)
test "$documented_version" = "$expected_version"
npm exec --prefix "$consumer_dir" -- pisama-ts --help >/dev/null

test -f "$install_dir/node_modules/@pisama/cli/THIRD_PARTY_NOTICES.md"

if [[ "${AUDIT_CLI_ARTIFACT:-0}" == "1" ]]; then
  npm audit --omit=dev --audit-level=moderate --prefix "$install_dir"
fi
