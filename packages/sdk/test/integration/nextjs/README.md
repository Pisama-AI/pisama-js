# Next.js App Router integration

The primary supported framework. The reference route at `src/app/api/chat/route.ts` matches what the install prompt asks AI builders to produce.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Next.js app

```bash
npx create-next-app@latest my-app
cd my-app
pnpm add @pisama/sdk @ai-sdk/openai
# copy src/app/api/chat/route.ts into your project
echo 'WHOOPSIE_PROJECT_ID=ws_yourid' >> .env.local
echo 'OPENAI_API_KEY=sk-...' >> .env.local
pnpm dev
# then npx @pisama/cli verify
```
