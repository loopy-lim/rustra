English | [한국어](./README.ko.md)

# @rustra/cli

The TypeScript code generation CLI for rustra-bridge. Generates type-safe clients
(commands/types/contract/frame codec) from the `schema.json` exported by the Rust backend.

## Usage

```sh
# 1. schema + TS/C++/RN integrated generation
rustra codegen --config rustra.json

# 2. schema already exists; re-render the generated output
rustra generate --schema ./generated/schema.json --output ./src/generated

# 3. also generate the C++ codec (for the RN JSI fast path)
rustra generate --schema ./gen/schema.json --output ./src/generated --cpp-output ./ios

# 4. dev mode (watch Rust sources + integrated codegen)
rustra dev --config rustra.json

# 5. verify generated output is in sync (CI gate)
rustra generate --config rustra.json --check

# 6. detect breaking changes between schema versions (CI gate)
rustra diff --old ./schema.v1.json --new ./schema.v2.json

# 7. initialize a new project scaffold
rustra init my-app

# 8. diagnose the host — toolchain, Cargo manifest, crates.io reachability
#    (registry.reachability, warn-only), device-token catalog
#    (codegen.device_catalog: skip/warn/pass/fail); --format json, --strict
rustra doctor --config rustra.json
```

See `rustra --help` for the full list of options. Exit code `2` means a usage error
(unknown command/flag or a missing required argument), `1` a runtime failure or a
breaking `diff`; `doctor`, `codegen`, `codegen --explain`, and `diff` share the
`--format json` envelope `{ "schemaVersion": 1, ... }`.

**Experimental dylib dev target**: `rustra dev` with `dev.target: "dylib"` also
builds the engine core as a cdylib for the native hot-core swap loop — the host
picks the artifact up via `RUSTRA_HOT_CORE` without a restart (the parity gate
composes as with the wasm target). See the
[tauri-calculator example](../../examples/tauri-calculator/README.md) and the
[hot-core design](../../docs/plans/2026-09-09-native-hot-core-design.md). Keep
the dylib loop in its own config file (for example `rustra.hot.json` with
`dev.target: "dylib"`) and run `rustra dev --config rustra.hot.json`, so the
shared config keeps its default `native` target — the pattern the
tauri-calculator example uses.

## Library API

The same generators as the CLI can be used directly in a program:

```ts
import { generateTypesTs, generateCommandsTs, diffSchemas } from '@rustra/cli';
```

| Module            | Contents                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `generate`        | generator functions for types/commands/contract/frame codec/registry |
| `schema`          | `PackageSchema` parsing and validation                               |
| `schema-diff`     | breaking-change detection between schema versions (`diffSchemas`)    |
| `validate-engine` | runtime invoke validation engine wrapper (`createValidatedEngine`)   |

## Related docs

- [rustra-bridge](https://github.com/loopy-lim/rustra#readme)
- `docs/getting-started.md` — the full pipeline (Rust `generate_typescript` → CLI)

`rustra dev --config rustra.json` reloads configuration changes and follows new,
removed, and atomically replaced source paths. It reconciles filesystem snapshots
every 100 ms without retaining native watch descriptors (including on Node/Bun
systems where `fs.watch` reaches its descriptor limit).

For projects with `uniffi`, `rustra codegen --check` checks the Rust mirror plus
schema/TypeScript/C++ output. Run `rustra codegen --check-bindings` as the explicit,
more expensive CI gate for actual Kotlin, Swift, headers, and module maps: it builds
the library, runs bindgen in an empty temporary directory, and compares all paths
and bytes with `uniffi.output`. This flag implies `--check` and preserves committed
files. Normal generation replaces the binding tree only after complete fresh
output passes validation; obsolete files are removed on success. Cargo's reported
compiler artifact controls the library path, while bindgen runs for the Rust host
target even when the project configures a different build target.

### Binding output boundary

`uniffi.output` must be a dedicated binding directory. Before running the Rust
probe, the CLI resolves paths and rejects overlap with schema/TypeScript outputs
or paths that cover the Cargo manifest or Rust source root. A separate directory
such as `uniffi/` or `src/bindings/` is valid. Keep handwritten files elsewhere because
successful generation replaces the whole tree. Watch ignores this tree and its
transaction staging directories.

### Repository verification runtime

Repository subprocess tests require Node 22 with `--experimental-strip-types`.
The published CLI keeps its Node 18 minimum runtime contract. `test:codegen-fresh`
builds the CLI and uses Node to check all six configured examples;
`test:bindings-fresh` selects only UniFFI examples and regenerates Swift/Kotlin.

### Hot-core retained-library diagnostics

Hot-core intentionally retains loaded libraries until process exit for symbol safety.
`rustra::hot_core::retained_library_stats()` exposes cumulative `libraries` (including
loads whose symbol binding failed) and `artifact_bytes` (sum of loaded file sizes,
not RSS). `restart_recommended()` becomes true at 32 retained loads; each additional
32 loads emits a restart recommendation. Restart the development host to release
them. Dropping a core does not unload libraries.
