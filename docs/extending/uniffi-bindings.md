English | [한국어](./uniffi-bindings.ko.md)

# UniFFI Bindings Guide (Kotlin/Swift)

## 1. What is the UniFFI transport?

UniFFI is rustra's fourth host surface, and it **coexists** with the existing
tiers (JSI/Tauri/Bun/Node). Where the existing tiers have a TS engine round-trip
postcard/Frame blobs, UniFFI is a **native value transfer**: bindings generated
by Mozilla UniFFI move values across with uniffi's own RustBuffer lift/lower, and
one typed function is generated per command
(`addNumbers(input: AddNumbersInput) -> AddNumbersOutput`). No postcard codec is
needed on the Kotlin/Swift side — uniffi generates the record→data
class/struct conversion.

When to choose it:

| Situation                                                         | Recommendation                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| React Native app — calling from TS via `engine.invoke`            | The existing JSI/Frame path (this guide is unnecessary)      |
| Pure Android (Kotlin) / iOS (Swift) app — Rust without a TS layer | UniFFI (this guide)                                          |
| Tauri app — webview calling Rust                                  | The Tauri adapter ([Tauri setup](tauri-setup.md))            |
| Node/Bun backends                                                 | Generated entries ([Getting Started](../getting-started.md)) |

The contract integrity of the UniFFI surface is owned not by rustra but by
**uniffi's own checksums + contract version** (the Track A philosophy of
ADR 0001, applied by the carrier). rustra's
`contract_hash`/`contract.mismatch` gate stays scoped to the blob transports
(JSI/Tauri/Bun/Node) — the decision record is
[ADR 0002](../adr/0002-uniffi-track-b1-carrier.md).

## 2. Architecture — the core stays uniffi-free

`crates/rustra` carries no uniffi dependency. What landed in the core are two
plain-Rust pieces:

- `Package::invoke_typed<I: Serialize, O: DeserializeOwned>(name, &input)`
  (`crates/rustra/src/invoke_typed.rs`) — looks the command up by name,
  assembles a Frame request frame from commandId + postcard, and executes it
  through the **single dispatch path** of `invoke_frame`. No second JSON
  execution path is forked, so the wire the TS codec sees and the wire an
  in-Rust call sees come from the same source, byte for byte.
- `decode_frame_response(frame)` / `decode_frame_error_parts(frame)`
  (`crates/rustra/src/frame_error.rs`) — shared helpers that split a response
  frame into a success body / an error `{code, message}`. Known limitation:
  `RustraError.code` is a `&'static str`, so the dynamic code on the wire cannot
  be reconstructed without allocating; the merged decoder
  (`decode_frame_response`) therefore surfaces errors as
  `internal: "<code>: <message>"` — parsers that need the exact parts use the
  structured variant (`decode_frame_error_parts`).

The uniffi derives all live in the **generated mirror layer of the app crate**.
The codegen-rendered `uniffi_generated.rs` consists of mirror types
(records/enums), per-command `#[uniffi::export]` typed functions, and
`uniffi::setup_scaffolding!()` at the crate root; lib.rs attaches it behind a
feature gate:

```rust
#[cfg(feature = "uniffi")]
include!("uniffi_generated.rs");
```

A default build involves no uniffi at all — only `--features uniffi` builds put
the scaffolding onto the cdylib.

## 3. Configuration — the `uniffi` section of `rustra.json`

```json
{
  "uniffi": {
    "output": "uniffi"
  }
}
```

| Key            | Required | Default   | Meaning                                                                               |
| -------------- | -------- | --------- | ------------------------------------------------------------------------------------- |
| `output`       | ✅       | —         | Directory uniffi-bindgen writes the Kotlin/Swift bindings to (relative to the config) |
| `srcOut`       | —        | `"src"`   | Directory the probe writes the committed `uniffi_generated.rs` to                     |
| `dylibProfile` | —        | `"debug"` | cdylib build profile used for binding generation (`"debug"` or `"release"`)           |

The **presence of the section itself is the feature switch** — without it the
codegen flow behaves byte-identically to before the section existed.

App-crate requirements (the calculator example is the reference
implementation — `examples/calculator/`):

1. `[lib] crate-type = ["rlib", "cdylib"]` — library-mode bindgen reads the
   cdylib.
2. A `uniffi = ["dep:uniffi"]` feature (the workspace dependency is an exact
   pin — §8).
3. `src/bin/uniffi-bindgen.rs`:
   `fn main() { uniffi::uniffi_bindgen_main() }`.
4. The probe binary honors the `RUSTRA_UNIFFI_OUT` environment variable and
   renders the mirror source (see
   `examples/calculator/src/bin/generate.rs`).
5. The `#[cfg(feature = "uniffi")] include!(...)` wiring in lib.rs (§2).

## 4. Codegen flow

The uniffi stage of `rustra codegen --config rustra.json` (write mode):

1. **Schema probe** — spawns the existing probe with the
   `RUSTRA_UNIFFI_OUT=<srcOut>` environment variable. The probe renders the
   mirror source into `uniffi_generated.rs` and writes it to srcOut (a commit
   target).
2. **cdylib build** — `cargo build --package <pkg> --lib --features uniffi
--message-format=json` (`--release` for the release profile). The selected lib
   target's compiler artifact supplies the actual library path, including custom
   names and configured target directories/triples.
3. **bindgen** — runs with an explicit Rust host `--target`, even if Cargo is
   configured to build the library for another target. Bindings are written into
   an empty temporary directory.
4. **Output verification and publish** — at least one `.kt`, `.swift`, `.h`, and
   `*.modulemap` must each exist in that fresh directory. Only a complete result
   replaces `uniffi.output`; failed generation preserves the previous tree and
   successful publication removes stale files.

`--check` compares only `uniffi_generated.rs` for UniFFI; this inexpensive check
**does not prove Kotlin/Swift freshness**. Use `rustra codegen --check-bindings`
as the explicit full binding CI gate. It implies `--check`, builds the library,
generates into an empty temporary directory, and compares the complete path set
and bytes (including Swift, Kotlin, headers, module maps and extra stale files)
without replacing committed output. Build artifacts may be written to Cargo's
target directory. This costs a native build and bindgen run.

The orchestration lives in `packages/cli/src/cli-uniffi.ts`; the mirror
renderer is `examples/calculator/src/uniffi_render.rs` (11 unit tests — meeting
a type the mirror cannot express fails while naming the schema path; there is
no silent skip).

## 5. Consuming Kotlin/Swift

One top-level function is generated per command. For the calculator example
(committed bindings: `examples/calculator/uniffi/`):

Kotlin (package `uniffi.rustra_calculator_example`):

```kotlin
import uniffi.rustra_calculator_example.*

val sum = addNumbers(AddNumbersInput(a = 2, b = 3)) // AddNumbersOutput(value = 5)

try {
    divide(DivideInput(a = 10.0, b = 0.0))
} catch (e: RustraCommandFailure.Failure) {
    println(e.code) // "math.divide_by_zero"
}
```

Swift:

```swift
let sum = try addNumbers(input: AddNumbersInput(a: 2, b: 3)) // AddNumbersOutput(value: 5)

do {
    _ = try divide(input: DivideInput(a: 10, b: 0))
} catch let failure as RustraCommandFailure {
    if case let .Failure(code, detail, retryable) = failure {
        print(code) // "math.divide_by_zero"
    }
}
```

**Error model** — a single-variant failure record
`RustraCommandFailure.Failure { code, detail, retryable }` (the same shape as
the TS `RustraCommandError`). rustra's error code space is open (unbounded
custom codes), so a uniffi enum mapping — which would require closing it — was
rejected.

Three generic functions are generated alongside:

- `invokeJson(command, argsJson)` — the name-based JSON path (a string-boundary
  wrapper over `Package::invoke_json`).
- `getSchema()` — the live schema (`Package::live_schema`). Unlike the TS-side
  schema it **includes the generation counter** (for hot-swap observation).
- `contractHash()` — the same single source as the FFI
  `rustra_ffi_contract_hash`.

**Loading model** — uniffi bindings bind cdylib symbols at load time. This
surface is therefore **static/release builds only** and cannot be combined with
dylib hot-swap (`hot-core`); the dev loop stays on the existing TS/JSI path.

## 6. Runtime smoke harnesses

Generated bindings are proven on real emulator/simulator runtimes by two
committed smoke harnesses, both wired as CI jobs (`.github/workflows/ci.yml`):

- **Android** — `examples/uniffi-android-smoke`: a minimal Gradle app loading
  the generated Kotlin bindings (`uniffi.rustra_calculator_example`, JNA-based)
  plus the Rust `.so` built with cargo-ndk. The app proves the happy path
  `addNumbers(20, 22) == 42` and the typed error path `divide(10, 0)` → code
  `"math.divide_by_zero"`, and only then prints the
  `__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42` marker via `Log.w`. The
  `uniffi-android` CI job boots an x86_64 emulator, installs the APK, and
  asserts the marker from the logcat.
- **iOS** — `examples/uniffi-ios-smoke`: `build-and-run.sh` builds the
  staticlib for `aarch64-apple-ios-sim`, links it with `swiftc` (registering
  the FFI module map), boots a simulator, spawns the smoke binary via
  `simctl`, and asserts the same marker. Runs as the `uniffi-ios` CI job.

These harnesses are the runtime half of the binding-freshness story: the
`--check-bindings` byte comparison (§4) catches committed-source drift, while
the smoke apps catch what only shows up at load/link time.

## 7. Limitations and documented divergences

Mechanical divergences of the mirror type mapping, deliberately documented
(each decided inside the renderer's fail-closed rules):

| Schema shape                    | Mirror representation                                               | Conversion                                               |
| ------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| set                             | `Vec<T>`                                                            | collected into a real `BTreeSet` during conversion       |
| fixed-length tuple              | synthetic record (`SpanInputPair` etc., `v0`..`vn` fields)          | `From` conversion                                        |
| map                             | `HashMap`/`BTreeMap`                                                | inference-based collect                                  |
| `getSchema()`                   | live schema (unlike the TS schema, includes the generation counter) | —                                                        |
| channel/resource handle newtype | `u32` scalar                                                        | only definitions in an explicit path table are unwrapped |

Remaining Phase 1 limitations:

- **Errors** — a single-variant record (§5). The merged decoder's
  `internal: "<code>: <message>"` flattening limitation (§2).
- **Identifier policy** — schema-derived names (types, fields, enum variants,
  command names) must be valid, non-keyword Rust identifiers. The renderer
  fails at generation time with the exact schema path instead of letting
  rustc fail opaquely later. Keyword names are deliberately **not**
  raw-escaped: uniffi 0.32 proc-macros and the Kotlin/Swift generators do not
  carry `r#` safely (the error mirror's `message`→`detail` rename is the one
  deliberate divergence). Properties that collapse to the same snake_case
  field (e.g. `fooBar` + `foo_bar`) are rejected as duplicates.
- **No async** — the Rust command API is synchronous today, so every generated
  function is sync. TS-option surfaces like `signal`/`timeoutMs` do not exist
  on this path.
- **Events/channels excluded** — Phase 2 (uniffi callback interfaces + foreign
  traits).
- **XCFramework/AAR publishing pipelines** — later. Phase 1 covers local builds
  plus verification of the committed binding sources.

## 8. uniffi version pin policy

The workspace dependency is `uniffi = "=0.32.1"` — an **exact pin**. As the
maturity study (`docs/research/2026-09-11-uniffi-maturity-catchup.md`)
established, uniffi churns per minor with breakage between generated bindings
and runtime helpers, and the generated Kotlin helpers require **exactly the
same uniffi version** as the compiled Rust component. To bump, change the
workspace pin in one place and regenerate the mirror source and the committed
bindings in the same PR — the `codegen --check-bindings` byte comparison catches Swift/Kotlin drift.

### Binding output boundary

`uniffi.output` must be a dedicated binding directory. Before running the Rust
probe, the CLI resolves paths and rejects overlap with schema/TypeScript outputs
or paths that cover the Cargo manifest or Rust source root. A separate directory
such as `uniffi/` or `src/bindings/` is valid. Keep handwritten files elsewhere because
successful generation replaces the whole tree. Watch ignores this tree and its
transaction staging directories.
