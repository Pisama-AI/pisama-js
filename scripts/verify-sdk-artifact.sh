#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <sdk-tarball> <detectors-tarball>" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sdk_archive=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
detectors_archive=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
max_tarball_bytes=${MAX_SDK_TARBALL_BYTES:-100000}

for archive in "$sdk_archive" "$detectors_archive"; do
  if [[ ! -f "$archive" ]]; then
    echo "artifact not found: $archive" >&2
    exit 1
  fi
done

tarball_bytes=$(wc -c <"$sdk_archive" | tr -d ' ')
if ((tarball_bytes > max_tarball_bytes)); then
  echo "@pisama/sdk artifact is ${tarball_bytes} bytes; budget is ${max_tarball_bytes}" >&2
  exit 1
fi

required_files=(
  package/package.json
  package/README.md
  package/CHANGELOG.md
  package/LICENSE
  package/dist/index.js
  package/dist/index.d.ts
  package/dist/version.js
  package/dist/version.d.ts
)

contents=$(tar -tzf "$sdk_archive")
for path in "${required_files[@]}"; do
  if ! grep -Fxq "$path" <<<"$contents"; then
    echo "@pisama/sdk artifact is missing $path" >&2
    exit 1
  fi
done

while IFS= read -r path; do
  case "$path" in
    package/package.json | package/README.md | package/CHANGELOG.md | package/LICENSE | package/dist/*.js | package/dist/*.js.map | package/dist/*.d.ts | package/dist/*.d.ts.map)
      ;;
    *)
      echo "@pisama/sdk artifact contains unexpected path: $path" >&2
      exit 1
      ;;
  esac
done <<<"$contents"

consumer_dir=$(mktemp -d)
cleanup() {
  rm -rf "$consumer_dir"
}
trap cleanup EXIT

npm install \
  --prefix "$consumer_dir" \
  --ignore-scripts \
  --package-lock=true \
  --no-fund \
  "$detectors_archive" \
  "$sdk_archive"

(
  cd "$consumer_dir"
  REPO_ROOT="$repo_root" CONSUMER_DIR="$consumer_dir" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoRoot = process.env.REPO_ROOT;
const consumerDir = process.env.CONSUMER_DIR;
assert.ok(repoRoot && consumerDir);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const source = await readJson(`${repoRoot}/packages/sdk/package.json`);
const installed = await readJson(
  `${consumerDir}/node_modules/@pisama/sdk/package.json`,
);
const detectors = await readJson(
  `${consumerDir}/node_modules/@pisama/detectors/package.json`,
);
const changelog = await readFile(
  `${consumerDir}/node_modules/@pisama/sdk/CHANGELOG.md`,
  "utf8",
);

assert.equal(installed.name, "@pisama/sdk");
assert.equal(installed.version, source.version);
assert.equal(installed.type, "module");
assert.equal(installed.engines?.node, ">=20");
assert.equal(installed.publishConfig?.access, "public");
assert.equal(
  installed.publishConfig?.registry,
  "https://registry.npmjs.org",
);
assert.equal(installed.license, "MIT");
assert.equal(installed.main, "./dist/index.js");
assert.equal(installed.types, "./dist/index.d.ts");
assert.equal(installed.exports?.["."]?.import, "./dist/index.js");
assert.equal(installed.exports?.["."]?.types, "./dist/index.d.ts");
assert.equal(
  installed.repository?.url,
  "git+https://github.com/Pisama-AI/pisama-js.git",
);
assert.equal(installed.repository?.directory, "packages/sdk");
assert.equal(
  installed.bugs?.url,
  "https://github.com/Pisama-AI/pisama-js/issues",
);
assert.equal(
  installed.homepage,
  "https://github.com/Pisama-AI/pisama-js/tree/main/packages/sdk#readme",
);
assert.equal(
  installed.dependencies?.["@pisama/detectors"],
  detectors.version,
);
assert.ok(!JSON.stringify(installed).includes("workspace:"));
assert.match(changelog, new RegExp(`^## \\[${source.version.replaceAll(".", "\\.")}\\]`, "m"));

const sdk = await import("@pisama/sdk");
assert.deepEqual(Object.keys(sdk).sort(), [
  "SDK_VERSION",
  "observe",
  "pisamaMiddleware",
  "redactObject",
  "redactText",
]);
assert.equal(sdk.SDK_VERSION, installed.version);
NODE
)

cat >"$consumer_dir/type-contract.mts" <<'TYPESCRIPT'
import {
  observe,
  pisamaMiddleware,
  redactObject,
  type PisamaMiddlewareOptions,
  type RedactMode,
  type TraceEvent,
} from "@pisama/sdk";
import type { LanguageModelV3 } from "@ai-sdk/provider";

declare const model: LanguageModelV3;
declare const event: TraceEvent;
const mode: RedactMode = "metadata-only";
const options: PisamaMiddlewareOptions = { redact: mode };
const observed: LanguageModelV3 = observe(model, options);
const middleware = pisamaMiddleware(options);
const redacted: unknown = redactObject(event, mode);

void [observed, middleware, redacted];
TYPESCRIPT

"$repo_root/node_modules/.bin/tsc" \
  --noEmit \
  --strict \
  --skipLibCheck \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  "$consumer_dir/type-contract.mts"

"$repo_root/node_modules/.bin/tsc" \
  --noEmit \
  --strict \
  --skipLibCheck \
  --target ES2022 \
  --module ESNext \
  --moduleResolution Bundler \
  "$consumer_dir/type-contract.mts"

npm audit \
  --prefix "$consumer_dir" \
  --omit=dev \
  --audit-level=moderate

echo "verified @pisama/sdk $(node -p "require('$consumer_dir/node_modules/@pisama/sdk/package.json').version")"
