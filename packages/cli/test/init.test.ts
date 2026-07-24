import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../src/init.js';

const FIXTURE_PKG = {
  name: 'vibe-app',
  version: '0.0.0',
  type: 'module',
  dependencies: {
    next: '^16.0.0',
    ai: '^6.0.0',
    '@ai-sdk/openai': '^2.0.0',
  },
};

const FIXTURE_ROUTE = `import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = await streamText({
    model: openai("gpt-4o"),
    messages,
  });
  return result.toAIStreamResponse();
}
`;

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    jsx: 'preserve',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ['**/*.ts', '**/*.tsx'],
});

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pisama-cli-'));
  await writeFile(join(root, 'package.json'), JSON.stringify(FIXTURE_PKG, null, 2));
  await writeFile(join(root, 'tsconfig.json'), FIXTURE_TSCONFIG);
  await mkdir(join(root, 'app', 'api', 'chat'), { recursive: true });
  await writeFile(join(root, 'app', 'api', 'chat', 'route.ts'), FIXTURE_ROUTE);
  return root;
}

test('init writes PISAMA_PROJECT_ID and patches the streamText call', async () => {
  const root = await makeFixture();
  try {
    // Silence init's stdout chatter
    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: root, open: false, dryRun: false });
    } finally {
      console.log = log;
    }

    const env = await readFile(join(root, '.env.local'), 'utf8');
    assert.match(env, /^PISAMA_PROJECT_ID=ps_[A-Za-z0-9_-]+/m);

    const route = await readFile(join(root, 'app', 'api', 'chat', 'route.ts'), 'utf8');
    // CLI 0.2.0+ emits the observe() helper from @pisama/sdk, not the
    // two-step wrapLanguageModel + pisamaMiddleware pattern. This matches
    // what the install page tells users to write.
    assert.match(route, /import \{ observe \} from "@pisama\/sdk"/);
    assert.match(route, /observe\(openai\("gpt-4o"\), \{ redact: "standard" \}\)/);
    // And the patcher should NOT introduce the old pattern.
    assert.doesNotMatch(route, /wrapLanguageModel/);
    assert.doesNotMatch(route, /pisamaMiddleware/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init dry-run does not modify files', async () => {
  const root = await makeFixture();
  try {
    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: root, open: false, dryRun: true });
    } finally {
      console.log = log;
    }

    const route = await readFile(join(root, 'app', 'api', 'chat', 'route.ts'), 'utf8');
    assert.equal(route, FIXTURE_ROUTE);

    let envExists = true;
    try {
      await readFile(join(root, '.env.local'), 'utf8');
    } catch {
      envExists = false;
    }
    assert.equal(envExists, false, '.env.local should not be written in dry-run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init second run is idempotent (does not double-wrap)', async () => {
  const root = await makeFixture();
  try {
    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: root, open: false, dryRun: false });
      await init({ cwd: root, open: false, dryRun: false });
    } finally {
      console.log = log;
    }

    const route = await readFile(join(root, 'app', 'api', 'chat', 'route.ts'), 'utf8');
    // Count observe() CALL sites (not the import). One call expected — no double-wrap.
    const callSites = (route.match(/observe\s*\(/g) ?? []).length;
    assert.equal(callSites, 1, `expected exactly one observe call, got ${callSites}\n${route}`);
    // And just one pisama import declaration.
    const imports = (route.match(/from "@pisama\/sdk"/g) ?? []).length;
    assert.equal(imports, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init reuses an existing project id from .env.local', async () => {
  const root = await makeFixture();
  try {
    await writeFile(
      join(root, '.env.local'),
      'PISAMA_PROJECT_ID=ws_existing_id_12345\nOTHER_VAR=foo\n',
    );

    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: root, open: false, dryRun: false });
    } finally {
      console.log = log;
    }

    const env = await readFile(join(root, '.env.local'), 'utf8');
    assert.match(env, /PISAMA_PROJECT_ID=ws_existing_id_12345/);
    assert.match(env, /OTHER_VAR=foo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init appends a project id after an env file without a trailing newline', async () => {
  const root = await makeFixture();
  try {
    await writeFile(join(root, '.env.local'), 'OTHER_VAR=kept');
    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: root, open: false, dryRun: false });
    } finally {
      console.log = log;
    }

    const env = await readFile(join(root, '.env.local'), 'utf8');
    assert.match(env, /^OTHER_VAR=kept\nPISAMA_PROJECT_ID=ps_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
