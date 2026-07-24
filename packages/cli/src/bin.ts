#!/usr/bin/env node
import { createRequire } from 'module';
import { Command } from 'commander';
import { analyzeAtif } from './analyze-atif.js';
import { init } from './init.js';
import { startMcpServer } from './mcp.js';
import { verify } from './verify.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('pisama')
  .description("See your AI app's failures live. https://pisama.ai")
  .version(version);

program
  .command('init')
  .description('Wire pisama observe() into your Next.js + AI SDK app')
  .option('--cwd <path>', 'Project root', process.cwd())
  .option('--no-open', 'Skip opening the browser')
  .option('--dry-run', 'Print planned changes without writing files')
  .action(async (opts) => {
    await init({
      cwd: opts.cwd,
      open: opts.open,
      dryRun: opts.dryRun,
    });
  });

program
  .command('mcp')
  .description(
    "Run an MCP server over stdio so any MCP-compatible AI assistant can read your project's failures.",
  )
  .option('-p, --project-id <id>', 'Pisama project id (defaults to PISAMA_PROJECT_ID env var)')
  .option('--base-url <url>', 'Override the Pisama API base URL (default https://api.pisama.ai)')
  .action(async (opts: { projectId?: string; baseUrl?: string }) => {
    const projectId = opts.projectId ?? process.env.PISAMA_PROJECT_ID;
    if (!projectId) {
      console.error('no project id. Pass --project-id or set PISAMA_PROJECT_ID.');
      process.exit(1);
    }
    await startMcpServer({ projectId, baseUrl: opts.baseUrl });
  });

program
  .command('verify')
  .description(
    'POST a synthetic trace and confirm it round-trips through the dashboard. Use after install to prove integration works.',
  )
  .option('--cwd <path>', 'Project root for reading .env.local', process.cwd())
  .option(
    '-p, --project-id <id>',
    'Override project id (defaults to PISAMA_PROJECT_ID or .env.local)',
  )
  .option('--base-url <url>', 'Override the Pisama API base URL (default https://api.pisama.ai)')
  .option('--timeout-ms <ms>', 'How long to wait for the trace to surface (default 15000)', (v) =>
    Number(v),
  )
  .action(
    async (opts: { cwd: string; projectId?: string; baseUrl?: string; timeoutMs?: number }) => {
      await verify({
        cwd: opts.cwd,
        projectId: opts.projectId,
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
      });
    },
  );

program
  .command('analyze-atif')
  .description(
    "Analyze a Harbor ATIF trajectory (or directory of trajectories) with Pisama's detectors. Exits non-zero on any high-severity finding so it works in CI.",
  )
  .argument('<path>', 'Path to an ATIF .json file or a directory of them')
  .option(
    '-p, --project-id <id>',
    'Optional Pisama project id to correlate with (reserved, not used in v0)',
  )
  .option('--base-url <url>', 'Override the Pisama base URL (default https://api.pisama.ai)')
  .option(
    '--apply',
    'After detection, apply the primary self-healing fix through the unified AutoApplyService path. Requires --framework, --entity-id, and --credentials.',
  )
  .option(
    '--framework <name>',
    'Target framework for --apply (n8n, langgraph, dify, openclaw, openai_assistants, bedrock_agents, managed_agents, semantic_kernel, github_pr).',
  )
  .option(
    '--entity-id <id>',
    'Framework entity id for --apply (n8n workflow_id, assistant_id, etc.).',
  )
  .option(
    '--credentials <jsonOrPath>',
    'Credentials JSON for --apply. Either an inline JSON object or a path to a .json file.',
  )
  .action(
    async (
      path: string,
      opts: {
        projectId?: string;
        baseUrl?: string;
        apply?: boolean;
        framework?: string;
        entityId?: string;
        credentials?: string;
      },
    ) => {
      await analyzeAtif({
        path,
        projectId: opts.projectId,
        baseUrl: opts.baseUrl,
        apply: opts.apply,
        framework: opts.framework,
        entityId: opts.entityId,
        credentials: opts.credentials,
      });
    },
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
