English | [한국어](./README.ko.md)

# @rustra/example-reference-app

The reference app for the `@rustra/react` hooks (useCommand/useMutation/useEvent/RustraProvider) —
shows how to compose CRUD and event flows.

## Structure

```
src/
  App.tsx     UI tree using the hooks (platform-agnostic — swap the engine only)
  app.ts      Node entrypoint — renders/verifies App with a mock engine + RustraProvider
```

`App.tsx` consumes the codegen output at `../../crud/generated/commands.js` — the crud
example must be built first (see Run below).

## Run (Node Smoke)

```bash
# From the repo root
bun run test:app:reference
# Or directly:
cargo build -p rustra-crud-example && \
  tsc -p examples/reference-app/tsconfig.json && \
  node examples/reference-app/dist/examples/reference-app/src/main.js
```

The smoke test runs the real hook tree and verifies CRUD round-trips (via a mock engine).

## Porting to Web/RN

The UI tree is identical anywhere — only the engine injection changes:

```tsx
// RN
const engine = createReactNativeEngine(NativeModules.RustraJSI);
<RustraProvider engine={engine}>
  <App />
</RustraProvider>;

// Web (Tauri)
const engine = createTauriEngine({ invoke: window.__TAURI__.core.invoke });
<RustraProvider engine={engine}>
  <App />
</RustraProvider>;
```

## What It Proves

- `useCommand` — auto-runs on mount, re-runs when the input changes, minify-safe
  identification based on `commandId`
- `useMutation` — composes success/failure callbacks without optimistic updates
- `useEvent` — cleans up (unsubscribes) event subscriptions
- `RustraProvider` — injects the engine scope
