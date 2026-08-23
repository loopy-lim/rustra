# Compatibility Contract

`rustra` generated TypeScript must stay host-neutral. The generated files may depend on this shape only:

```ts
export type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

That contract is the stable bridge for:

- Node: an adapter calls local Rust through a process, N-API, or another Node transport.
- Bun: an adapter calls local Rust through Bun FFI, subprocess, or another Bun transport.
- Tauri: an adapter maps `EngineClient.invoke` to `window.__TAURI__.core.invoke` or a plugin invoke.
- React Native: an adapter maps `EngineClient.invoke` to an Expo Module, Turbo/Nitro module, or future native transport.

The generated command helpers must not import or mention host-specific APIs such as `node:`, `bun:`, `@tauri-apps`, `react-native`, or `expo`.

Current verification:

```bash
cargo test --workspace
bun run test:compat
```

`bun run test:compat` includes two different classes of checks:

- Adapter contract checks: generated commands call injected Tauri and React Native transports without importing host packages.
- Runtime checks: Node and Bun execute the Rust calculator binary, and the Tauri example builds a real app then launches it long enough for WebView JavaScript to call a Rust command through `window.__TAURI__.core.invoke`. The Tauri command handler calls the shared `rustra` calculator package through `Package::invoke`, not a separate hand-written calculator path.
- React Native app checks: the RN fixture typechecks against the same generated command helper and `@rustra/react-native` adapter. The native module (`rustra-jsi`) is implemented and verified — real-device JSI invoke measured at ~0.95µs and the Release build is covered in CI.

React Native passed its runtime gate: the native JSI module exists, real-device invocations were verified, and CI builds the Release app. See `docs/benchmarks.md` for the measured fast-path numbers.

## Stable Adapter Boundaries

Each adapter package has a deliberately small stable range.

| Package                | Stable range                                                             | Out of scope for this layer                                          |
| ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `@rustra/node`         | Convert a Node-side async transport into `EngineClient`                  | Choosing N-API vs subprocess vs HTTP                                 |
| `@rustra/bun`          | Convert a Bun-side async transport into `EngineClient`                   | Choosing Bun FFI vs subprocess vs HTTP                               |
| `@rustra/tauri`        | Convert a Tauri `invoke(command, args)` function into `EngineClient`     | Tauri plugin registration, ACL/capability generation                 |
| `@rustra/react-native` | Convert a native module with `invoke(command, args)` into `EngineClient` | Expo Module, TurboModule, Nitro, Swift/Kotlin implementation details |

The invariant is the same for every host:

```ts
generatedCommand(engine, input)
  -> engine.invoke(commandName, input)
  -> host transport(commandName, input)
```

Adapters must not import each other. Tauri and React Native adapters must not import their host packages directly; callers inject the host transport. That keeps generated client code reusable and keeps native/runtime choices outside the command contract.

## Same-Code Requirement

Host examples must use the same command surface:

- The same Rust command package owns command registration and dispatch.
- The same generated TypeScript command helper is imported by host app code.
- The only host-specific JavaScript difference is which adapter creates the `EngineClient`.
- The only host-specific native/runtime difference is how that adapter transport reaches Rust.

For the calculator example, the shared path is `addNumbers({ a, b })` (with the engine installed globally via `configure(engine)`). Node, Bun, and Tauri must not keep separate app-local calculator logic that bypasses the generated helper or `rustra` package dispatch.

React Native follows the same JavaScript path in `examples/react-native-calculator/App.tsx`, dispatching through the native `rustra-jsi` module (C++ JSI bridge + generated postcard codecs).

## Runtime Acceptance Gates

These are the non-negotiable gates before calling a host "actually working":

| Host         | Pass condition                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node         | A Node app calls the generated TypeScript helper, the helper calls `@rustra/node`, and the adapter invokes a Rust process that returns the expected JSON result.                                         |
| Bun          | A Bun app calls the generated TypeScript helper, the helper calls `@rustra/bun`, and the adapter invokes a Rust process that returns the expected JSON result.                                           |
| Tauri        | A Tauri app builds, launches, WebView JavaScript calls the generated `addNumbers` helper through `@rustra/tauri`, and the Rust command handler calls the shared `rustra` package with `Package::invoke`. |
| React Native | A React Native app launches on simulator/device, JavaScript calls the generated TypeScript helper, the native module calls Rust code, and the UI or probe observes the Rust result.                      |

Until a host reaches its pass condition, docs and scripts must call it an adapter or bundle check, not a runtime pass.
