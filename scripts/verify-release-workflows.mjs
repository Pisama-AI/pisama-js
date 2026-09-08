import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const releases = [
  ['publish-cli.yml', '@pisama/cli', 'packages/cli', 'cli-v'],
  ['publish-detectors.yml', '@pisama/detectors', 'packages/detectors', 'detectors-v'],
  ['publish-sdk.yml', '@pisama/sdk', 'packages/sdk', 'v'],
  ['publish-whoopsie-cli.yml', '@whoopsie/cli', 'packages/whoopsie-cli', 'whoopsie-cli-v'],
  [
    'publish-whoopsie-detectors.yml',
    '@whoopsie/detectors',
    'packages/whoopsie-detectors',
    'whoopsie-detectors-v',
  ],
  ['publish-whoopsie-sdk.yml', '@whoopsie/sdk', 'packages/whoopsie-sdk', 'whoopsie-sdk-v'],
];

function occurrences(source, literal) {
  return source.split(literal).length - 1;
}

function expectCount(source, literal, expected, label) {
  assert.equal(
    occurrences(source, literal),
    expected,
    `${label}: expected ${expected} occurrence(s) of ${JSON.stringify(literal)}`,
  );
}

for (const [filename, packageName, packageDir, tagPrefix] of releases) {
  const label = `.github/workflows/${filename}`;
  const source = readFileSync(label, 'utf8');

  assert.match(source, /^on:\n  workflow_dispatch:\n/m, `${label}: must be manually dispatched`);
  expectCount(source, `package-name: '${packageName}'`, 2, label);
  expectCount(source, `package-dir: ${packageDir}`, 2, label);
  expectCount(source, `tag-prefix: ${tagPrefix}`, 2, label);
  expectCount(source, "if: ${{ github.ref == format('refs/tags/{0}', inputs.git_tag) }}", 2, label);
  expectCount(source, 'ref: ${{ github.sha }}', 2, label);
  expectCount(source, 'fetch-depth: 0', 2, label);
  expectCount(source, 'persist-credentials: false', 2, label);
  expectCount(source, 'event-ref: ${{ github.ref }}', 2, label);
  expectCount(source, 'event-sha: ${{ github.sha }}', 2, label);
  expectCount(source, 'expected-sha256: ${{ inputs.expected_sha256 }}', 2, label);
  expectCount(source, 'environment: npm-staging', 1, label);
  expectCount(source, 'id-token: write', 1, label);
  assert.doesNotMatch(source, /ref:\s*refs\/tags\//, `${label}: tag ref checkout is mutable`);
  assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/, `${label}: token fallback is forbidden`);
}

const prepare = readFileSync('.github/actions/prepare-npm-stage/action.yml', 'utf8');
const stage = readFileSync('.github/actions/stage-npm-package/action.yml', 'utf8');
const runbook = readFileSync('RELEASING.md', 'utf8');
const packedConsumer = readFileSync('scripts/verify-packed-consumer.sh', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.packageManager, 'pnpm@10.34.5', 'reviewed package-manager version');
const pnpmSetup = 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413';
expectCount(ci, pnpmSetup, 3, 'CI bootstrap');
expectCount(prepare, pnpmSetup, 1, 'release bootstrap');
expectCount(ci, 'node-version: "22.14.0"', 1, 'release reproduction');
expectCount(ci, 'python-version: "3.11.13"', 1, 'release reproduction');
expectCount(
  ci,
  'sha256sum --check "$GITHUB_WORKSPACE/scripts/reviewed-release-sha256.txt"',
  1,
  'reviewed digests',
);
assert.doesNotMatch(ci, /id-token: write|npm stage publish|npm publish/, 'CI must not publish');
expectCount(prepare, "python-version: '3.11.13'", 1, 'prepare action');
expectCount(packedConsumer, 'python3 scripts/test_canonicalize_npm_archive.py', 1, 'packed gate');
expectCount(
  packedConsumer,
  'python3 scripts/canonicalize-npm-archive.py "$release_dir"/*.tgz',
  1,
  'packed gate',
);
for (const [label, source] of [
  ['prepare action', prepare],
  ['stage action', stage],
]) {
  for (const identityCheck of [
    'test "$EVENT_REF" = "refs/tags/$RELEASE_TAG"',
    'test "$(git rev-parse HEAD)" = "$EVENT_SHA"',
    'test "$(git rev-parse "$RELEASE_TAG^{}")" = "$EVENT_SHA"',
    'test "$(git tag --points-at "$EVENT_SHA" --list "$RELEASE_TAG")" = "$RELEASE_TAG"',
    'git merge-base --is-ancestor "$EVENT_SHA" origin/main',
  ]) {
    expectCount(source, identityCheck, 1, label);
  }
}

expectCount(
  stage,
  'npm install --global npm@11.19.1 --ignore-scripts --registry=https://registry.npmjs.org/',
  1,
  'stage action',
);
expectCount(stage, 'if [[ ! -f "$npmrc" ]]', 2, 'stage action');
expectCount(stage, '-name .npmrc -print0', 2, 'stage action');
expectCount(stage, 'npm stage publish "$artifact"', 1, 'stage action');
expectCount(stage, '--provenance --registry="$expected_registry"', 1, 'stage action');
assert.doesNotMatch(
  stage,
  /npm publish|npm stage approve/,
  'stage action must never publish or approve',
);

for (const requiredGate of [
  'Pisama-AI/pisama-js',
  'GitHub environment `npm-staging`',
  '`npm stage publish` only',
  'direct trusted `npm publish` is disabled',
  'Require two-factor authentication and\n  disallow tokens',
  'legacy automation token and granular access token',
  'post-revocation token list',
]) {
  assert.ok(runbook.includes(requiredGate), `RELEASING.md: missing mandatory gate ${requiredGate}`);
}
for (const [filename, packageName] of releases) {
  assert.ok(
    runbook
      .split('\n')
      .some(
        (line) => line.startsWith(`| \`${packageName}@`) && line.includes(`| \`${filename}\` |`),
      ),
    `RELEASING.md: missing exact package/workflow mapping for ${packageName}`,
  );
}

console.log(`Verified ${releases.length} immutable, digest-bound npm staging workflows.`);
