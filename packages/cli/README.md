English | [한국어](./README.ko.md)

# @rustra/cli

The TypeScript code generation CLI for rustra-bridge. Generates type-safe clients
(commands/types/contract/rkyv codec) from the `schema.json` exported by the Rust backend.

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
[hot-core design](../../docs/plans/2026-09-09-native-hot-core-design.md).

## Library API

The same generators as the CLI can be used directly in a program:

```ts
import { generateTypesTs, generateCommandsTs, diffSchemas } from '@rustra/cli';
```

| Module            | Contents                                                            |
| ----------------- | ------------------------------------------------------------------- |
| `generate`        | generator functions for types/commands/contract/rkyv codec/registry |
| `schema`          | `PackageSchema` parsing and validation                              |
| `schema-diff`     | breaking-change detection between schema versions (`diffSchemas`)   |
| `validate-engine` | runtime invoke validation engine wrapper (`createValidatedEngine`)  |

## Related docs

- [rustra-bridge](https://github.com/loopy-lim/rustra#readme)
- `docs/getting-started.md` — the full pipeline (Rust `generate_typescript` → CLI)
