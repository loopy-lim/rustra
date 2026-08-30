English | [한국어](./development-hurdles.ko.md)

# Reducing development hurdles

Rustra connects Rust commands to native code, so it cannot remove every environment dependency. Instead, it can check the required tools before installation, bundle Rust schema generation and TypeScript/C++ generation into one command, and automatically verify generated output sync in CI.

This document is based on the behavior of the current checkout without version changes. Because the CLI, JS packages, and Rust crate have independent version ranges, actual compatibility must be confirmed against the project's lockfile together with the generated manifest.

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
