# Next.js App Router integration

The reference route at `src/app/api/chat/route.ts` shows the supported
`observe()` integration for a Next.js App Router handler.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Next.js app

```bash
npx create-next-app@latest my-app --use-pnpm
cd my-app
pnpm add @pisama/sdk@alpha ai@^6 @ai-sdk/openai@^2
# copy src/app/api/chat/route.ts into your project
echo 'PISAMA_PROJECT_ID=ps_your_project_id' >> .env.local
# Add OPENAI_API_KEY to .env.local through your normal secret-management flow.
pnpm dev
```

In another terminal, verify delivery:

```bash
npx --yes --package=@pisama/cli@latest -- pisama verify
```
