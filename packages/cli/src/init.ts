import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import kleur from 'kleur';
import { nanoid } from 'nanoid';
import open from 'open';
import { patchStreamTextCallSite } from './patch.js';

export interface InitOptions {
  cwd: string;
  open: boolean;
  dryRun: boolean;
}

const DASHBOARD_BASE = 'https://pisama.ai/live';

export async function init(opts: InitOptions): Promise<void> {
  const root = resolve(opts.cwd);

  step('Detecting your project...');
  const pkg = await readPackageJson(root);
  const hasAi = hasDep(pkg, 'ai');
  const hasNext = hasDep(pkg, 'next');

  if (!hasAi || !hasNext) {
    fail(
      `pisama needs Next.js + Vercel AI SDK. Detected: ai=${hasAi}, next=${hasNext}.\n` +
        `  Run: ${kleur.cyan('pnpm add ai next')} and try again.`,
    );
  }

  ok(`Found ${kleur.bold(String(pkg.name ?? 'project'))} with ai + next.`);

  const projectId = await ensureProjectId(root, opts.dryRun);
  ok(`Project ID: ${kleur.bold(projectId)}`);

  step('Patching the first streamText / generateText call site...');
  const patched = await patchStreamTextCallSite(root, opts.dryRun);
  if (patched) {
    ok(`Wrapped model in ${kleur.bold(patched)} with observe().`);
  } else {
    warn('No streamText/generateText call site found. Add the wrapper manually:');
    console.log(kleur.dim("\n  import { observe } from '@pisama/sdk';"));
    console.log(kleur.dim("  const model = observe(yourModel, { redact: 'metadata-only' });\n"));
  }

  const dashboardUrl = `${DASHBOARD_BASE}/${projectId}`;
  console.log('');
  console.log(kleur.bold('  Live dashboard: ') + kleur.cyan().underline(dashboardUrl));
  console.log(kleur.dim('  Now run your dev server and hit your chat route once.'));
  console.log('');

  if (opts.open && !opts.dryRun) {
    await open(dashboardUrl).catch(() => {
      // Browser open is best-effort; never fail init on it.
    });
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown>> {
  const path = join(root, 'package.json');
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    fail(`No package.json at ${path}. Run from your project root.`);
  }
}

function hasDep(pkg: Record<string, unknown>, name: string): boolean {
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  return name in deps || name in devDeps;
}

async function ensureProjectId(root: string, dryRun: boolean): Promise<string> {
  const envPath = join(root, '.env.local');
  let existing: string | null = null;
  try {
    await access(envPath);
    const raw = await readFile(envPath, 'utf8');
    const match = raw.match(/^PISAMA_PROJECT_ID=([^\n]+)/m);
    if (match) existing = match[1]!.trim();
  } catch {
    // No .env.local yet, fine.
  }

  if (existing) return existing;

  const projectId = `ps_${nanoid(16)}`;
  const line = `PISAMA_PROJECT_ID=${projectId}\n`;

  if (dryRun) {
    console.log(kleur.dim(`  [dry-run] would append to .env.local: ${line.trim()}`));
    return projectId;
  }

  try {
    const raw = await readFile(envPath, 'utf8');
    await writeFile(envPath, `${raw}${raw.endsWith('\n') ? '' : '\n'}${line}`, 'utf8');
  } catch {
    await writeFile(envPath, line, 'utf8');
  }
  return projectId;
}

function step(msg: string): void {
  console.log(kleur.cyan('→') + ' ' + msg);
}
function ok(msg: string): void {
  console.log(kleur.green('✓') + ' ' + msg);
}
function warn(msg: string): void {
  console.log(kleur.yellow('!') + ' ' + msg);
}
function fail(msg: string): never {
  console.error(kleur.red('✗') + ' ' + msg);
  process.exit(1);
}
