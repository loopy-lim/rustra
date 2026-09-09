English | [한국어](./development-hurdles.ko.md)

# Reducing development hurdles

Rustra connects Rust commands to native code, so it cannot remove every environment dependency. Instead, it can check the required tools before installation, bundle Rust schema generation and TypeScript/C++ generation into one command, and automatically verify generated output sync in CI.

This document is based on the behavior of the current checkout without version changes. Because the CLI, JS packages, and Rust crate have independent version ranges, actual compatibility must be confirmed against the project's lockfile together with the generated manifest.

## Running the CLI — three standard forms

| Form                                                 | When                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `bunx --bun @rustra/cli <cmd>`                       | recommended one-off form (no install, pinned by bunx) |
| `bun add -d @rustra/cli` + `bunx --bun rustra <cmd>` | projects running CLI commands as package scripts      |
| `bun i -g @rustra/cli` + `rustra <cmd>`              | rarely — only for machines that need a global binary  |

`rustra init` scaffolds package scripts (`bun run doctor`, `bun run codegen`, …)
that use the dependency form; CI and docs examples use the `bunx` form. All
commands accept `--config rustra.json` explicitly.

Exit codes are uniform across commands: `2` means the CLI was invoked wrong (a usage
error — unknown command, unknown flag, or a missing required argument such as
`codegen` without `--config` or `diff` without `--old`/`--new`); `1` means the command
ran and failed (a codegen error, a `doctor` failure, a breaking `diff`); `0` is
success. `--help` is handled once in the entry point for every command, so
`rustra dev --help` prints usage without entering watch mode. `doctor`, `codegen`,
`codegen --explain`, and `diff` accept `--format json` and share one envelope,
`{ "schemaVersion": 1, ... }`: `codegen` reports `{ written, drift, durationMs }`,
`--explain` reports `{ explain }`, and `diff` reports `{ breaking, clean }` with the
exit code unchanged (`1` when breaking). `dev` is text-only.

## Starting without Rust: the mock engine

The UI does not have to wait for a native build. `@rustra/testing`'s
`createMockEngine` is a real `EngineClient` — install it once with `configure()`
and the generated command helpers run unchanged, no Rust toolchain involved:

```bash
bun add @rustra/testing @rustra/types
```

```ts
// src/mock.ts — import early while the UI is still under construction
import { createMockEngine } from '@rustra/testing';
import { configure } from '@rustra/types';
import { addNumbers } from './generated/commands.js';

const engine = createMockEngine()
  // string form — any command name
  .on('addNumbers', ({ a, b }) => ({ value: a + b }))
  // typed form — resolves the name from the generated function, typos fail fast
  .mock(addNumbers, ({ a, b }) => ({ value: a + b }))
  // simulate failures: {code,message} becomes a structured RustraCommandError
  .fail('secureCompute', { code: 'capability.denied', message: 'not granted in mock' });

configure(engine); // installs into the global invoke

const result = await addNumbers({ a: 20, b: 22 }); // 42 — no Rust involved
engine.calls(); // [{ command: 'addNumbers', args: { a: 20, b: 22 } }]
```

The mock also covers the non-happy paths:

- `createMockEngine({ delayMs: 50 })` or `.delay('addNumbers', 50)` — latency for
  cancellation/loading-state tests (an aborted `signal` rejects with the same
  `CancelledError` contract as the real adapters).
- `.emit('progress.tick', payload)` + `engine.subscribeEvent(name, cb)` — drive
  event-driven UIs and inspect the emitted history with `.events()`.
- `.reset()` between test cases; `.calls()` records every invoke for order and
  argument assertions.
- The package also exports contract gates (`assertContractCurrent`,
  `expectContractCurrent`, …) that fail when `generated/` drifts from the
  committed schema — see `packages/testing/src/contract-gate.ts`.

Swap the mock for the generated host entry by removing the `configure()` call —
nothing else in app code changes.

## First-run path

A new project starts in the following order.

```bash
bunx --bun @rustra/cli init my-project
cd my-project
bun install
bun run doctor
bun run codegen
```

`rustra init` creates `rustra.json` along with the following scripts.

```json
{
  "doctor": "rustra doctor --config rustra.json",
  "codegen": "rustra codegen --config rustra.json",
  "codegen:check": "rustra codegen --config rustra.json --check",
  "dev": "rustra dev --config rustra.json"
}
```

## `rustra doctor`

`doctor` diagnoses the current host without installing anything or changing files.

```bash
bunx --bun @rustra/cli doctor --config rustra.json
bunx --bun @rustra/cli doctor --config rustra.json --format json
bunx --bun @rustra/cli doctor --config rustra.json --strict
```

It commonly checks Rust MSRV 1.88+, Cargo, Node/Bun, a C/C++ compiler, CMake, the Cargo manifest, and the configured Rust target. Only when React Native is configured does it additionally check Xcode/CocoaPods on macOS, and on Android Java 17, `ANDROID_NDK_ROOT` or the NDK `27.1.12297006` in the SDK, and the default Rust Android targets. Tauri configuration also includes per-host native build tools.

Two checks look past the local toolchain. `registry.reachability` fetches `https://index.crates.io/config.json` with a 3-second timeout and reports `warn` — never `fail`, so an offline CI stays green — when crates.io is unreachable, with proxy (`HTTPS_PROXY`/`HTTP_PROXY`) and offline (`CARGO_NET_OFFLINE=true`) hints; it is skipped when Cargo itself is missing. `codegen.device_catalog` reads the generated `schema.json`: `skip` when no command declares devices, `warn` when commands declare devices but the schema has no `deviceCapabilities` catalog (regenerate with a current rustra), `pass` when every declared token is in the catalog, and `fail` for tokens outside it — debug builds accept such tokens with a warning while release builds panic at registration (see [dev-tier.md](dev-tier.md)).

Each failure prints the checked value together with a copyable next action. `--format json` can be used for CI annotations or IDE integration, and `--strict` treats warnings as failures too. `doctor` performs no automatic installation.

## Unified codegen and dev loop

Instead of the previous two commands, the CLI locates the Rust generator the config points to and runs the following pipeline.

```text
Select a target via Cargo metadata
  -> cargo run --bin <configured generator>
  -> schema.json
  -> TypeScript/C++/React Native generation
  -> .rustra-generated.json record
```

`rustra.json` can name the Rust manifest, package, and binary explicitly so the choice is unambiguous within the workspace.

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustPackage": "my-app",
    "rustBinary": "generate"
  }
}
```

If the binary is omitted, a binary named `generate`, or the single binary, is used. With two or more candidates it does not guess automatically; it prints `codegen.rust_binary_ambiguous` together with the candidates.

Without `--config`, `codegen` falls back to `./rustra.json` when that file exists (the same default as `doctor`). In text mode it prints the same file list as `generate`, each line suffixed `(unchanged)` or `(updated)`. Any `(updated)` line means a committed artifact changed, and because codegen never rebuilds the runtime binary that serves `invoke`, the CLI appends a hint to run `cargo build` — until then invokes can fail with `contract.mismatch`. If `cargo` itself is not on `PATH`, the codegen error names that directly and points to <https://rustup.rs> instead of surfacing a bare `ENOENT`.

To keep generating while editing Rust, use the following.

```bash
bun run dev
```

In config mode `dev` calls the `codegen` orchestrator in the same process instead of guessing where the CLI is installed or spawning a separate CLI process. It watches Rust `src`, `Cargo.toml`, `Cargo.lock`, and the schema, and a Linux write event whose content equals the generated schema does not schedule codegen again. Because both watch modes share one state machine, further changes during a run coalesce into a single pending run and long Cargo builds never overlap. The legacy `--backend`/`--app` watch modes are also kept for compatibility.

## Generated output drift gate

Regular generation updates the output and `.rustra-generated.json`. Projects that commit the generated TS/C++/RN files can add the following command to CI.

```bash
bun run codegen:check
```

`generate --check` compares the bytes, schema hash, and generator version of every file expected from the current schema against the manifest and writes no files. It reports on-disk content changes and a stale manifest as distinct errors, and treats missing, changed, or unexpected files as failures. `codegen --check` passes an `RUSTRA_SCHEMA_OUT` temporary directory to the Rust generator so the Cargo stage does not write to the working tree either, then verifies TS/C++/RN. Generated Rust files are not rewritten when the content is identical.

Every generated file carries a self-describing header (file name, source, regen command, stage) in the comment syntax of its file type: `//` for TypeScript, C++, Swift, Kotlin, Gradle, and every other slash-comment file; `#` for `CMakeLists.txt`/`.cmake`, `.podspec`, `.rb`, `.py`, `.sh`, `.yml`/`.yaml`, `.toml`, `.properties`, `.gitignore`, and `.env`; `<!-- -->` for `.xml`/`.html`, where the `--config rustra.json` flag is written as `[config: rustra.json]` because an XML comment cannot contain `--`. A shebang line stays first and the header follows it. JSON files carry no header at all — JSON has no comment syntax — so `.rustra-generated.json` is the only provenance record for them. The header is part of the bytes that `--check` and the manifest hashes compare, so editing it is drift like any other edit.

## Runtime diagnostics: `RUSTRA_DEBUG`

Set `RUSTRA_DEBUG=1` (also `true` or `verbose`) in the process environment to turn on the opt-in diagnostics every adapter shares through `@rustra/types`. The value is read once per process at first use.

- Every wire round trip is logged through `console.debug` as a `[rustra:debug]` event carrying `direction` (`request`/`response`/`error`), `transport` (`json`/`rkyv`/`typed`), `command`, a bounded hex `bytes` preview with `byteLength`, and a truncated `value` snapshot (depth 3, 32 entries, 2 KB budget). Nothing is logged unless debug is on, so secrets stay out of logs by default.
- The raw wire bytes are additionally hex-dumped to stderr as `[rustra:wire] <direction> <hex>` (first 256 bytes).
- The JSON engine emits a `kind: 'response.shape'` warning event when a resolved response looks like a wire-envelope anomaly — `reason` is one of `double_envelope`, `failed_without_error`, `envelope_missing_payload`, `resolved_error_envelope` — the usual symptom of a JS/native version skew. The warning never throws and never changes the result.
- `@rustra/node` emits `kind: 'ndjson.unparsed'` for every stdout line the NDJSON loop could not parse and warns on stderr once. Without debug mode it instead keeps the last 32 unparsed lines (each cut at 4 096 characters) and attaches them to the error of requests still pending when the child process exits; in debug mode an 8 KB stderr tail is attached as well.

React Native has no `process.env` — set `globalThis.__RUSTRA_DEBUG__ = true` instead (this enables the event log; the stderr hex dump is env-only). For a structured consumer, install a sink with `configureDebug(sink)` from `@rustra/types`: the sink receives every `RustraDebugEvent` even when `RUSTRA_DEBUG` is unset, and `configureDebug(undefined)` removes it.

## Realistic per-platform boundaries

### Rust and the native toolchain

The Rustra CLI itself installs as an npm/Bun package. The application's native output, however — the user's `#[command]`, schema, and staticlib — depends on the app and target, so no single universal prebuilt binary can replace it.

- Node/Bun alone still needs Rust, a C/C++ linker, and Node/Bun.
- Tauri needs the Rust and C/C++ tools of the given host.
- React Native needs Xcode/CocoaPods on iOS and SDK/NDK 27+ plus Java 17 on Android, and uses a development build rather than Expo Go.

Teams should avoid making every developer rebuild the native archive every time; instead, CI should build the archive per platform and architecture and provide it as a cache or internal artifact. That artifact is an app-specific result valid only for the same Rust commit, schema hash, and target — it is not the universal runtime prebuilt that Rustra ships.

### Expo Go

Rustra's RN adapter embeds C++ JSI and Rust FFI, so it cannot be loaded into Expo Go after the fact. An Expo app creates a development build once and then runs it.

```bash
bunx --bun expo prebuild
bunx --bun expo run:ios
# or
bunx --bun expo run:android
```

### Rust type boundary

Bridge parameters and return values must be owned data expressible through `#[bridge_type]` and Serde/Schemars. The restriction that references, `dyn Trait`, and closures cannot be passed directly cannot be lifted, but documentation and schema validation should surface the boundary at the codegen stage. When channel/resource features are needed, use an owned handle contract instead of the callback itself.

### Performance tiers

Flattened primitive types, fixed tuples, and simple structs use the postcard/rkyv fast path. Nested structs, struct-valued maps, data enums, and the like are handled by the schema-driven complex codec, and unsupported shapes fall back to the Tier 3 JSON fallback. Performance claims therefore must separate per-type paths, and complex payloads must be benchmarked with the real schema.

### Runtime registry and unsafe

The dynamic command registry has a u16 command ID space of at most 65,534 entries, and retired IDs are never reused. In release the registry is frozen, so runtime plugin injection is not treated as a default extension point.

The unsafe Rust/C++ boundary of the zero-copy FFI remains. Application users go through the generated modules and adapter APIs; contributors touching bridge internals must pass Miri, sanitizers, fuzzing, and native builds together.

## Problems with few external references

The 0.x API can still change, so run `doctor`, `codegen:check`, and `rustra diff` together in CI and lock the CLI/Rust/adapter versions separately. When reproducing an issue, leaving the following information behind makes diagnosis possible without descending into the source code.

```bash
bunx --bun @rustra/cli doctor --config rustra.json --format json > rustra-doctor.json
bun run codegen:check
bunx --bun @rustra/cli diff --old generated/schema.v1.json --new generated/schema.json
```
