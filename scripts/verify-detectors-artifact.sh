#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <detectors-tarball>" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
archive=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
max_tarball_bytes=${MAX_DETECTORS_TARBALL_BYTES:-100000}

if [[ ! -f "$archive" ]]; then
  echo "artifact not found: $archive" >&2
  exit 1
fi

tarball_bytes=$(wc -c <"$archive" | tr -d ' ')
if ((tarball_bytes > max_tarball_bytes)); then
  echo "@pisama/detectors artifact is ${tarball_bytes} bytes; budget is ${max_tarball_bytes}" >&2
  exit 1
fi

required_files=(
  package/package.json
  package/README.md
  package/CHANGELOG.md
  package/LICENSE
  package/dist/index.js
  package/dist/index.d.ts
)

contents=$(tar -tzf "$archive")
for path in "${required_files[@]}"; do
  if ! grep -Fxq "$path" <<<"$contents"; then
    echo "@pisama/detectors artifact is missing $path" >&2
    exit 1
  fi
done

while IFS= read -r path; do
  case "$path" in
    package/package.json | package/README.md | package/CHANGELOG.md | package/LICENSE | package/dist/*.js | package/dist/*.js.map | package/dist/*.d.ts | package/dist/*.d.ts.map)
      ;;
    *)
      echo "@pisama/detectors artifact contains unexpected path: $path" >&2
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
  "$archive"

REPO_ROOT="$repo_root" CONSUMER_DIR="$consumer_dir" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.REPO_ROOT;
const consumerDir = process.env.CONSUMER_DIR;
assert.ok(repoRoot && consumerDir);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const source = await readJson(`${repoRoot}/packages/detectors/package.json`);
const installed = await readJson(
  `${consumerDir}/node_modules/@pisama/detectors/package.json`,
);
const changelog = await readFile(
  `${consumerDir}/node_modules/@pisama/detectors/CHANGELOG.md`,
  "utf8",
);

assert.equal(installed.name, "@pisama/detectors");
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
assert.equal(installed.repository?.directory, "packages/detectors");
assert.equal(
  installed.bugs?.url,
  "https://github.com/Pisama-AI/pisama-js/issues",
);
assert.equal(
  installed.homepage,
  "https://github.com/Pisama-AI/pisama-js/tree/main/packages/detectors#readme",
);
assert.equal(installed.dependencies, undefined);
assert.ok(!JSON.stringify(installed).includes("workspace:"));
assert.match(changelog, new RegExp(`^## \\[${source.version.replaceAll(".", "\\.")}\\]`, "m"));

const detectors = await import(
  pathToFileURL(
    `${consumerDir}/node_modules/@pisama/detectors/dist/index.js`,
  ),
);
assert.deepEqual(Object.keys(detectors).sort(), [
  "MultiAgentClient",
  "MultiAgentDetectors",
  "PisamaBackendError",
  "checkConsecutive",
  "checkDiversity",
  "completionDetector",
  "contextDetector",
  "costDetector",
  "createMultiAgentDetectors",
  "derailmentDetector",
  "detectCompletion",
  "detectContext",
  "detectCost",
  "detectCycle",
  "detectDerailment",
  "detectHallucination",
  "detectLoop",
  "detectRepetition",
  "hallucinationDetector",
  "loopDetector",
  "noIssue",
  "repetitionDetector",
  "runDetectors",
  "v1Detectors",
]);
assert.equal(detectors.v1Detectors.length, 7);
assert.ok(!("delegation" in detectors.MultiAgentDetectors));
assert.ok(!("consensus_collapse" in detectors.MultiAgentDetectors));
NODE

cat >"$consumer_dir/type-contract.mts" <<'TYPESCRIPT'
import {
  createMultiAgentDetectors,
  runDetectors,
  type AgentTrace,
  type CoordinationResult,
  type DetectionResult,
  type Detector,
} from "@pisama/detectors";

declare const trace: AgentTrace;
declare const detector: Detector;
const detections: DetectionResult[] = runDetectors(trace, [detector]);
const clients = createMultiAgentDetectors();
declare const coordination: Promise<CoordinationResult>;

void [detections, clients, coordination];
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

echo "verified @pisama/detectors $(node -p "require('$consumer_dir/node_modules/@pisama/detectors/package.json').version")"
