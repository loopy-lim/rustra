English | [한국어](./README.ko.md)

# rustra

[![CI](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml/badge.svg)](https://github.com/loopy-lim/rustra/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rustra/types)](https://www.npmjs.com/package/@rustra/types)
[![crates.io](https://img.shields.io/crates/v/rustra.svg)](https://crates.io/crates/rustra)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A bridge framework that generates type-safe TypeScript clients from Rust
commands — define once in Rust, run on Node, Bun, Tauri, and React Native.

## How It Works

```
Rust #[command] definition → TypeScript client codegen → platform adapter execution
```

- Define functions with `#[command]` on the Rust side
- `generate_typescript()` publishes the contract; `rustra codegen` renders type-safe TS client code from it
- Node, Bun, Tauri, and React Native adapters all route through the same
  `EngineClient` interface

## Why rustra (Comparison)

Tools that bridge a single Rust core to multiple JS hosts each make different
trade-offs:

|                                 | **rustra**                           | napi-rs           | Nitro Modules | Tauri commands | tauri-specta |
| ------------------------------- | ------------------------------------ | ----------------- | ------------- | -------------- | ------------ |
| Single Rust core × multi-host   | ✅ Node/Bun/Tauri/RN                 | Node (+ Electron) | RN-centric    | Tauri only     | Tauri only   |
| Type-safe codegen (both ways)   | ✅ commands+events                   | manual d.ts       | ✅            | ❌ (manual)    | ✅           |
| Compact binary wire             | ✅ rkyv V2 (11.8× smaller than JSON) | JSON/Buffer       | JSI objects   | JSON IPC       | JSON IPC     |
| Contract gate (breaking change) | ✅ `rustra diff` + contract hash     | ❌                | ❌            | ❌             | partial      |
| Cancel/timeout/batch semantics  | ✅ documented as a matrix            | DIY               | DIY           | ❌             | ❌           |

rustra's choice: **own the whole RPC surface (definition → codegen → wire →
verification) as a single contract.** Command invocation and contract
verification stay common across hosts, while capability differences such as
cancellation, events, and channels are documented explicitly in the
[compatibility matrix](docs/compatibility-matrix.md).

## Roadmap

- [x] 4 host adapters (Node/Bun/Tauri/RN iOS+Android) — 0.1
- [x] rkyv V2 binary fast-path + cancel/timeout/batch — 0.1~0.2
- [x] Event contract codegen (`PackageBuilder::event`) — 0.2.x
- [x] Persistent loop runtime + Node loop transport — 0.2.x
- [x] Type parity stage 1 — fast path type expansion (2026-08-22): u8–u64 plain
      varint, dynamic maps `HashMap<String,T>` (primitive values), tuples
      (unprefixed), `Vec<u8>` bytes (ArrayBuffer surface), chrono Date (ISO
      string), Set<unsigned> — 3-surface (TS·Rust·C++) codegen + PINNED hex
      wire gates.
- [x] Type parity stage 3 — schema-driven complex binary route (2026-08-27):
      recursive structs, struct-valued maps, data enums, nested Option/Set —
      shared Codec IR, TS/Rust golden wire + bounds, native-safe C++ complex
      marshalling. Primitive-element Sets and the `number | bigint` boundary
      for int64/uint64 are handled directly in the native-safe subset; the
      rest, such as object-element Sets, falls back safely to the JS complex
      codec.
- [x] Type parity stage 2 — channels/resources (Tauri v2 `ipc::Channel`·
      `Resource` model, 2026-08-23): callbacks become serializable channel
      handles (u32, invocation-scoped unicast replies) and object references
      become Rust-owned resource handles (`channels.rs` `ChannelHost` table,
      read/write/close via codegen'd commands). The wire carries only integer
      handles, so the contract gate and bidirectional codegen stay common;
      per-host channel adapter support follows the
      [compatibility matrix](docs/compatibility-matrix.md). RN JSI
      `createChannel(cb)`/`dropChannel(h)` wiring + Rust FFI
      `rustra_ffi_channel_{create,send,drop}` — verified end-to-end on an
      Android arm64 physical device; iOS generic device build and iPhone 17
      Simulator Release runtime done, physical-device runtime evidence
      pending.
- [x] Async command handlers — `#[command] async fn`, waker-based executor,
      bounded FFI worker pool / backpressure / cancellation gates
- [x] Windows core runtime verification — Windows MSVC tests in CI + release
      DLL artifact
- [x] Lowered development hurdles — `rustra doctor`, config-based
      `rustra codegen`, `rustra dev`, generated-output drift gate
      (`rustra generate --check`)
- [x] Single-arrow codegen + self-describing generated files (2026-09-01):
      the Rust bin is a contract probe that publishes `schema.json` only
      (`write_schema_to_dir`, honoring `RUSTRA_SCHEMA_OUT`), and
      `rustra codegen` renders every TS/C++ surface from that single file —
      the dual-pass trap of two writers producing the same files is gone.
      Every generated file carries a header naming its source and regen
      command; `rustra doctor` detects stale generated output
      (`codegen.generated_freshness`); `rustra codegen --explain` maps which
      surfaces a config touches; a CI onboarding gate runs
      init → doctor → build → codegen → demo in a scratch project
      (`bun run test:onboarding` upstream).
- [x] Event surface completion — Node push events with the diff gate
      (2026-09-02): `subscribeEvent` on Node prefers the `events:"push"`
      handshake over stdout 0xfffd frames with a capability-recheck polling
      fallback, Bun's FFI event bridge is auto-wired from generated entries,
      and `rustra diff` gates event removal/payload changes as breaking.
- [x] Docs sync gate (2026-09-02): `bun run test:docs` verifies every
      `docs:sync` region against the real generated file it mirrors —
      docs-to-reality drift now fails CI instead of being noticed by readers.
- [x] User-defined generic types at the concrete-instance level
      (2026-09-01): `Wrapper<String>` as a command payload generates the
      monomorphized schemars type (`Wrapper_for_String`) — command
      `inputType`/`outputType` now come from `JsonSchema::schema_name`, so
      generic payloads yield valid TypeScript identifiers that match the
      schema title and definitions keys. Parameterized templates (`Wrapper<T>`
      itself) are not emitted; see the
      [type guide](docs/rust-api-guide.md#user-defined-generic-types).
- [ ] Universal prebuilt application native binaries — depends on per-app Rust
      code and target; CI artifact/cache approach recommended instead

Stability tracks: versioning, compatibility guarantees, and the deprecation
cycle are defined in the
[versioning policy](docs/versioning-policy.md).

## FAQ

**Q. Is a Rust toolchain strictly required?**
App-specific native libraries must be built with Rust and the platform
toolchain. The CLI and shared adapters install via Bun/npm, but the
app-specific native artifacts that contain your commands and staticlib need
Rust and the platform toolchain. Teams can have CI produce per-commit/per-target
native artifacts for developers to reuse. To build the UI first without Rust,
use the mock engine from `@rustra/testing`. See the
[development hurdles guide](docs/development-hurdles.md) for diagnostics and
install scope.

**Q. Is the JSON path still supported?**
Yes. Complex schemas not covered by the postcard fast-path are handled by the
schema-driven complex binary route, and commands unsupported by both binary
routes fall back to JSON (Tier 3). Environments where binary is hard to ship
share the same contract.

**Q. Can I adopt incrementally into an existing napi-rs/Tauri app?**
Yes. Adapters only swap the transport — pass your existing invoke function to
`createNodeEngine(transport)` and those commands enter the rustra contract.

**Q. What happens when a schema drifts?**
`rustra diff` catches breaking changes in CI, and the contract hash detects
JS/native combination drift at runtime.

## Installation

### Rust

<!-- 발행 시 갱신: 0.7.0 라인 -->

```toml
[dependencies]
rustra = "0.6"
serde = { version = "1", features = ["derive"] }
schemars = { version = "0.8", features = ["derive"] }
```

### TypeScript adapters (only the environments you need)

```bash
bun add @rustra/node      # Node.js
bun add @rustra/bun       # Bun
bun add @rustra/tauri     # Tauri
bun add @rustra/react-native  # React Native
bun add @rustra/testing       # Mock engine (tests)
bun add @rustra/devtools      # Invocation observability (dev)
```

## Quick Example

```rust
use rustra::prelude::*;

// #[command] takes a single Input struct and returns Result<Output>.
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }
#[bridge_type]
struct AddNumbersOutput { sum: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}

fn main() -> Result<()> {
    let package = rustra::build!("example.calculator", add_numbers).done();

    // Contract probe: publish schema.json — `rustra codegen` renders TS/C++ from it.
    package.generate_typescript()?.write_schema_to_dir("generated")?;
    Ok(())
}
```

To use the binary fast-path (rkyv V2, RN), also run the CLI codegen. Specifying
the Rust generator in `rustra.json` processes schema generation through
`rkyv-codecs.ts`/`rkyv-registry.ts` in one shot:

```bash
bunx --bun @rustra/cli codegen --config rustra.json
```

If you only need to re-render an existing schema, use `generate --config`
directly. To watch Rust sources, use `bunx --bun @rustra/cli dev --config
rustra.json`; for the CI sync check use `bunx --bun @rustra/cli generate
--config rustra.json --check`.

### React Native: shared setup for Expo and bare RN

React Native never modifies the app's native project directly. Declare the
static library output and mobile entry in the Rust crate, enable `reactNative`
in the app's `rustra.json`, and the generator produces a conflict-isolated
local package.

```toml
[lib]
crate-type = ["rlib", "staticlib"]
```

```rust
rustra::native_entry!(my_package);
```

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "reactNative": {}
}
```

```bash
bun add @rustra/react-native @rustra/types
bun add -d @rustra/cli
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli codegen --config rustra.json
bun install
```

```ts
import { addNumbers } from './generated/react-native';

const result = await addNumbers({ a: 20, b: 22 });
```

The first call performs JSI installation, contract verification, and fast
engine setup exactly once. The generated `@rustra/generated-react-native`
package owns the iOS Podspec and Android Gradle/CMake, so both Expo development
builds and bare React Native use standard autolinking. Expo Go cannot load
native JSI modules. Specify `reactNative.rustManifest` as the app crate's
`Cargo.toml` only when the Cargo workspace is ambiguous.

Node, Bun, and Tauri follow the same generated-entrypoint convention. Enable
the hosts you need with empty objects and Cargo metadata plus standard host
APIs are inferred.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "node": {},
  "bun": {},
  "tauri": {}
}
```

```ts
import { addNumbers } from './generated/node.js'; // bun.js for Bun, tauri.js for Tauri

const result = await addNumbers({ a: 20, b: 22 });
```

Manual `configure()` is only for cases that intentionally step outside auto
inference: multiple runtimes, custom N-API, disabling global Tauri, and the
like.

## Real-World Examples

Generated host entrypoints own the connection, so no transport setup remains
in product code. All of the following call the same Rust `addNumbers` command.

### Node batch jobs

```ts
import { addNumbers, rustra } from './generated/node.js';

try {
  const [a, b] = process.argv.slice(2).map(Number);
  const { value } = await addNumbers({ a, b });
  console.log(value);
} finally {
  rustra.dispose();
}
```

The default generated path is a one-shot process with simple installation,
which suits low-frequency CLIs and batch jobs. For servers with continuous
request flow, use `createNodeLoopTransport`; for microsecond-scale calls,
choose N-API rkyv V2. Working code lives in
[`node-app.ts`](examples/calculator/apps/node-app.ts) and the
per-performance-tier picks in
[`node-performance.ts`](examples/calculator/apps/node-performance.ts).

### Bun HTTP service

```ts
import { addNumbers, rustra } from './generated/bun.js';

const server = Bun.serve({
  async fetch(request) {
    const input = (await request.json()) as { a: number; b: number };
    return Response.json(await addNumbers(input));
  },
});
process.on('SIGTERM', () => {
  rustra.dispose();
  server.stop();
});
```

This path uses the generated stable C ABI and rkyv V2 codec directly. No
separate `dlopen`, pointer freeing, or contract verification code is needed in
the app. The runnable minimal example is
[`bun-ffi-app.ts`](examples/calculator/apps/bun-ffi-app.ts).

### Tauri UI and events

```ts
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent<{ value: number }>('calc.tick', ({ value }) => renderTick(value));
button.addEventListener('click', async () => {
  const { value } = await addNumbers({ a: 20, b: 22 });
  output.value = String(value);
});
```

After `withGlobalTauri` and the Rust-side `register_with_events`, there is no
frontend configuration. [`tauri-calculator`](examples/tauri-calculator/)
includes a real WebView IPC build, run, and performance receipt.

### Expo development build and bare React Native

```tsx
import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import { addNumbers } from './generated/react-native';

export function Calculator() {
  const [value, setValue] = useState<number>();
  return (
    <View>
      <Button
        title="Run Rust"
        onPress={() => void addNumbers({ a: 20, b: 22 }).then((result) => setValue(result.value))}
      />
      <Text>{value ?? 'Ready'}</Text>
    </View>
  );
}
```

The same autolinked package without Expo APIs, so app code is identical in
both environments. Full screen examples: the
[`Expo App.tsx`](examples/react-native-calculator/App.tsx) and the
[`bare RN App.tsx`](examples/react-native-bare-calculator/App.tsx). Expo Go is
not supported because it cannot include native JSI code.

If you are coming from 0.3.1, align the npm and Rust versions together. For
per-host manual boundaries and before/after, follow
[migrating from 0.3 to 0.4](docs/migrations/0.3-to-0.4.md). If your Rust crates
are on the 0.5 line, follow
[migrating from 0.5 to 0.6](docs/migrations/0.5-to-0.6.md).

## Project Structure

```txt
crates/
  rustra/          Rust package authoring API (core)
  rustra-macros/   #[command], #[bridge_type] proc macros, build! macro

packages/
  node/            Node adapter
  bun/             Bun adapter
  tauri/           Tauri adapter
  react-native/    React Native adapter
  react/           React hooks (Provider/useCommand/useMutation/useEvent)
  testing/         Mock engine + contract gate (createMockEngine)
  devtools/        Invocation observability wrapper (createInstrumentedEngine)

examples/
  calculator/              Basic example (Rust crate + C FFI + stdio + generated TS)
  crud/                    CRUD pattern example (create/get/list/update/delete)
  benchmark/               Performance benchmark (payload scaling, throughput)
  tauri-calculator/        Tauri runtime example
  react-native-calculator/ React Native runtime example
  calculator-napi/         napi-rs transport example (source of the release transport benchmark)
  streaming/               Event streaming example (Package::emit + subscribeEvent adapter)
  auth/                    Session/capability gate example (deny-by-default)
  reference-app/           @rustra/react hooks reference app (useCommand/useMutation/useEvent)
```

## Local Disk Management

Development and test Cargo profiles store no incremental cache and no
dependency debug info.

```bash
bun run clean:dry    # report sizes without deleting deep-clean targets
bun run clean:build  # remove Rust/Xcode/Android/TS build artifacts, keep installed deps
bun run clean:deep   # build artifacts + node_modules/Pods/local package caches
```

Cleanup commands only remove explicitly listed regenerable paths. Do not use
`git clean -fdX` for disk cleanup — it can delete local mobile projects and
config files too.

## Rust: Defining Commands

```rust
use rustra::prelude::*;

// Every #[command] takes a single Input struct (or no args) and returns Result<O>.
#[bridge_type]
struct AddNumbersInput {
    a: i64,
    b: i64,
}

#[bridge_type]
struct AddNumbersOutput {
    sum: i64,
}

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}

// Commands without arguments work too
#[command]
fn ping() -> Result<String> {
    Ok("pong".to_string())
}

// Commands needing a capability gate: one attribute (deny-by-default until granted)
#[command(capability = "compute:secure")]
fn locked_add(input: AddNumbersInput) -> Result<AddNumbersOutput> { ... }
```

Build the package and generate TypeScript code:

```rust
fn main() -> Result<()> {
    // register multiple commands at once with the build! macro
    let package = rustra::build!("example.calculator", add_numbers).done();

    package.generate_typescript()?.write_schema_to_dir("generated")?;
    Ok(())
}
```

## Runtime Command Registry (dev / prod)

In **debug builds**, `Package` allows adding/replacing/removing commands at
runtime. In **release builds**, the registry automatically freezes at `build()`
and becomes immutable. Building the same binary as debug/release is all it
takes to pick dev (mutable) vs prod (immutable) behavior.

```rust
use rustra::prelude::*;

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> { /* ... */ }

#[command]
fn double(input: AddNumbersInput) -> Result<AddNumbersOutput> { /* ... */ }

let pkg = rustra::build!("my.pkg", add_numbers).done();

// The following work in debug builds only. In release builds: Err(code: "registry.frozen").
pkg.register_fn(double)?;            // runtime registration (name inferred → "double")
pkg.register("triple", double)?;     // named registration
pkg.replace("addNumbers", double)?;  // swap handler (command_id preserved)
pkg.unregister("triple")?;           // removal
pkg.freeze();                        // explicit seal (simulate prod behavior in debug)
```

- Dynamically registered commands are invoked through the name-based JSON path
  (`engine.invoke('double', ...)`).
- `command_id` (`u16`) is monotonically increasing and is **never reused**
  after `unregister` (retired).
- `Package` clones share the same registry (`Arc`-based).
- Limit: the `command_id` space holds at most 65,534 entries. Beyond that:
  `registry.id_exhausted` error.

## Invocation Cancellation (AbortSignal)

Cancel in-flight calls with the JS `invoke(cmd, args, { signal })` option. If
the native side exposes `invokeAsync`/`invokeCancel`, cancellation propagates
to Rust checkpoints (JS codec path); otherwise it falls back to a shallow
cancel that only rejects the JS promise immediately. The error code is
`cancelled` (retryable).

Rust FFI: `rustra_ffi_invoke_cancel(id)` / `rustra_ffi_cancellation_status(id)`
— `invoke_async` issues a per-call ID via the `invocation_id` out-param.

## OTA Schema Compatibility

Absorbs schema drift in JS-bundle-only deployments (old JS + new native):

- `PackageBuilder::alias_command_id(name, legacy_id)` — the new native accepts
  command_ids baked by old JS codegen as aliases (the rkyv V2 wire has no
  names).
- `schema_version(n)` — the version in schema.json. Codegen exposes it as
  `SCHEMA_VERSION`.
- Engine option `onContractMismatch` — continue in a degraded mode instead of
  throwing on contract hash mismatch (opt-in). `schemaVersion`/`onSchemaStale`
  — stale warnings for JS > native combinations (OTA rollback etc.).

## Payload Size Limits

Adjust the payload cap (default 1 MiB) at runtime:
`rustra_ffi_set_max_payload(bytes)` / `rustra_ffi_get_max_payload()`. The JS
engine option `maxPayloadBytes` checks the size right after encoding and fails
fast before the native round trip (tier2/tier3/propagation paths; the typed
path uses the native gate).

## TypeScript: Generated Client

The same interface on every platform:

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

type RustraError = {
  readonly code: string;
  readonly message: string;
};
```

### Type Mapping

| Rust                 | TypeScript                                         |
| -------------------- | -------------------------------------------------- |
| `i64`                | `number \| bigint`                                 |
| `u32`, `f64`         | `number`                                           |
| `String`             | `string`                                           |
| `bool`               | `boolean`                                          |
| `Vec<T>`             | `T[]`                                              |
| `(A, B, C)`          | `[A, B, C]`                                        |
| `HashMap<String, T>` | `Record<string, T>`                                |
| `Option<T>`          | `T \| null` (also `?:` when the field is optional) |
| `enum { A, B }`      | `'A' \| 'B'`                                       |
| struct               | `{ field: type; ... }`                             |

Each adapter implements `EngineClient`, so generated command helpers behave
identically regardless of platform.

## Platform Adapters

### Tauri

Enable the `tauri` feature:

<!-- 발행 시 갱신: 0.7.0 라인 -->

```toml
rustra = { version = "0.6", features = ["tauri"] }
```

Rust side:

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

TypeScript side:

```ts
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
```

Turning on `app.withGlobalTauri` in the Tauri config lets the generated
entrypoint lazily detect the IPC and event APIs. The existing
`createTauriEngine({ invoke })` is the escape hatch for apps that do not use
the global API.

### Node / Bun / React Native

Node connects to a Cargo binary, Bun to a stable C ABI cdylib, and React
Native to autolinked JSI — each lazily from the generated entrypoint. When only
the deployment layout differs, Node overrides the path with
`RUSTRA_NODE_BINARY` and Bun with `RUSTRA_BUN_LIBRARY`.

#### React Native

React Native uses the rkyv V2 binary fast-path by default. The JSI native
module must expose `invokeRkyvV2`. Commands whose input and output are each a
single required `Vec<u8>` field can also use the explicit `Uint8Array`/
`ArrayBuffer`-only native path when registered explicitly in Rust. Complex
schema commands go through the JS codec registry over the same `invokeRkyvV2`;
direct C++ marshalling is a separate performance extension.

```ts
import { addNumbers } from './generated/react-native.js';

const result = await addNumbers({ a: 20, b: 22 });
```

For native module setup (iOS JSI / Android C++), see the
[React Native setup guide](docs/extending/react-native-setup.md).

### Platform Support Matrix

| Platform             | Current evidence level     | Notes                                                                                   |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| Node / Bun           | Runtime verified           | subprocess·N-API·Bun FFI local runtime + adapter CI                                     |
| Tauri (macOS)        | WebView runtime verified   | Release WebView `rustra_dispatch` accuracy·performance receipt                          |
| Tauri (Linux)        | Build + smoke verified     | Real WebView user flows need separate E2E                                               |
| React Native iOS     | Simulator runtime verified | Release build·install·launch·reload·Nitro comparison; physical-device evidence separate |
| React Native Android | Release runtime verified   | `TB710FU` arm64 physical device plus arm64/x86_64 `.so` checks; other devices separate  |

`bun run test:compat` verifies the JS contract and supported local runtimes,
and the CI native jobs verify build and link. Neither should be equated with
real-device install and screen-render evidence. The checks that must be run
and recorded by hand (real WebView, real device, emit timing) live in the
[host verification manual checklist](docs/verification-checklist.md) — an
evidence level in this table is backed by a filled checklist block, not by CI
green alone.

## Performance

End-to-end Release measurements of calling
`addNumbers({ a: 20, b: 22 })` through the generated API or documented
high-performance paths. Accuracy was confirmed first on 2026-08-24 Apple
Silicon, then repeated 3 times after warm-up.

| Real user path                  | Mean latency |       p50 |    Throughput | Recommended use     |
| ------------------------------- | -----------: | --------: | ------------: | ------------------- |
| Node generated one-shot         |      2.76 ms |   2.76 ms |     363 ops/s | CLI, low-freq batch |
| Node persistent loop            |     16.86 µs |  16.67 µs |  59,301 ops/s | General servers     |
| Node N-API rkyv V2 escape hatch |      1.26 µs |   1.17 µs | 793,185 ops/s | High-freq hot path  |
| Bun generated FFI rkyv V2       |      2.27 µs |   2.21 µs | 439,961 ops/s | Services, CLI       |
| Tauri generated WebView IPC     |    279.04 µs | 300.00 µs |   3,584 ops/s | Desktop UI commands |
| RN generated JSI, iOS Simulator |            — |   2.71 µs |             — | Mobile hot path     |

Mean and throughput are 5% two-sided trimmed means to reduce OS scheduling
tail values. Tauri used per-call values from a 20-call batch due to WKWebView
timer precision. The RN row is the Rustra add p50 from the final Release
receipt, in a different iOS Simulator environment from the other rows. Bare RN
and Android build the same generated bridge but have no separate runtime
performance receipt, so no numbers were estimated. Reproduce all hosts with
`bun run bench:hosts`, and RN with the receipt commands below.

> In the 2026-08-24 iPhone 17 Simulator Release measurement, plain object ops
> were a 3-run median of add 1.0418x, string 1.0281x, pair 1.0535x versus
> Nitro, and 64B bytes were 0.9543x. The dedicated byte path was 64 KiB
> 0.9338x and exact 1 MiB-wire 1.0129x. Each run was auto-extracted as a JSON
> receipt with paired 95% CI. These are simulator receipts, not iOS/Android
> physical-device performance claims.
> For comparison scope, feature parity, per-layer overhead, and payload
> scalability, see the [benchmark doc](docs/benchmarks.md).

## Error Handling

Rust:

```rust
// Error raised in a command
return Err(RustraError::command_not_found("unknownCommand"));

// Invalid arguments
return Err(RustraError::invalid_args("expected non-empty name"));

// Internal error
return Err(RustraError::internal("database connection failed"));

// Custom error
return Err(RustraError::custom("validation.too_large", "value exceeds limit"));
```

TypeScript:

```ts
try {
  const result = await addNumbers({ a: 1, b: 2 });
} catch (e) {
  if (e instanceof RustraCommandError) {
    console.log(e.code, e.message); // "validation.too_large" "value exceeds limit"
  }
}
```

## Development

```bash
# Test the whole Rust workspace
# (--workspace ignores default-members, which builds the macOS-only
#  tauri-calculator too. CI uses the same command: .github/workflows/ci.yml)
cargo test --workspace

# The CI rust job runs on an ubuntu/macos/windows 3-OS matrix and uploads
# per-platform cdylib (.so/.dylib/.dll) artifacts (.github/workflows/ci.yml).

# Build the calculator example and generate TS
cargo run -p rustra-calculator-example --bin generate   # contract probe: schema.json
bun run codegen                                          # render TS surfaces

# Build the CRUD example and generate TS
cargo run -p rustra-crud-example --bin generate   # contract probe: schema.json
bun run --cwd examples/crud codegen               # render TS surfaces

# TypeScript lint / format
bun run lint
bun run format:check

# Rust lint / format
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

# Diagnose the dev environment
bunx --bun @rustra/cli doctor --config rustra.json

# Generate Rust schema + TS/C++/RN in one shot
bunx --bun @rustra/cli codegen --config rustra.json

# Generated-file sync CI gate (TS/C++/RN excluded)
bunx --bun @rustra/cli generate --config rustra.json --check

# Watch Rust sources + re-run integrated codegen automatically
bunx --bun @rustra/cli dev --config rustra.json
```

## Documentation

Full documentation lives in [`docs/`](docs/).

| Doc                                                              | Contents                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| [Getting started](docs/getting-started.md)                       | Installation, first package, adapter choice            |
| [Architecture overview](docs/architecture.md)                    | Data flow, EngineClient contract, transport separation |
| [Transport swap guide](docs/extending/transport-guide.md)        | Bun FFI, Node napi-rs replacement                      |
| [React Native setup guide](docs/extending/react-native-setup.md) | iOS JSI module setup, usage, troubleshooting           |
| [Development hurdles guide](docs/development-hurdles.md)         | doctor, integrated codegen, drift, native boundary     |
| [Adding a new host guide](docs/extending/adding-host.md)         | Adding new adapters like Electron, Deno                |
| [Full doc index](docs/README.md)                                 | Reading paths for users / contributors                 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
