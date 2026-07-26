# Express integration

The reference at `src/index.ts` shows `observe()` inside a standard Express
route.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Express app

```bash
mkdir my-app && cd my-app
pnpm init
pnpm add express @pisama/sdk@alpha ai@^6 @ai-sdk/openai@^2
pnpm add --save-dev tsx typescript @types/express
# copy src/index.ts as a reference
PISAMA_PROJECT_ID=ps_your_project_id OPENAI_API_KEY="$OPENAI_API_KEY" pnpm exec tsx src/index.ts
```

In another terminal, verify delivery:

```bash
PISAMA_PROJECT_ID=ps_your_project_id \
  npx --yes --package=@pisama/cli@latest -- pisama-ts verify
```

Express needs an explicit response pipe because it does not natively return
Web `Response` objects. The `observe()` call is unchanged.
