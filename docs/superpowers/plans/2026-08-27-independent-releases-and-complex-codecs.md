# Independent Releases and Complex Codecs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 0.4 release candidate, allow independently versioned Rustra packages, and support complex recursive data contracts through a tested binary codec path.

**Architecture:** Keep the existing postcard fast path for its proven schema subset. Add a schema-driven complex codec selected per command, with one CLI codec IR and explicit schema metadata shared by Rust, TypeScript, and C++. Release validation moves from exact lockstep versions to dependency compatibility and packed-consumer evidence.

**Tech Stack:** Rust 2024, Cargo workspace, TypeScript, Bun, Changesets, postcard, serde/serde_json/schemars, generated C++/JSI, React Native, GitHub Actions, Criterion.

**Spec:** `docs/superpowers/specs/2026-08-27-independent-releases-and-complex-codecs.md`

## Global Constraints

- Preserve the existing dirty React Native native-path changes.
- Do not publish npm or crates.io artifacts in implementation tasks.
- Existing postcard byte contracts remain unchanged.
- Complex maps sort UTF-8 keys and structs use declaration field order.
- Complex enum variant order comes from explicit schema metadata, never guessed from `oneOf` ordering.
- Every new production behavior starts with a failing test and a focused test command.
- A generated route must be either complete or excluded with an actionable reason; no partial codec registration.
- Release coherence must permit different public npm versions while enforcing valid dependency ranges and generated Rust compatibility.

## Current execution status (2026-08-27)

The implementation slice is complete and the release candidate has been
verified at source, package, native-build, Android device, and iOS Simulator
runtime boundaries. The iOS Simulator receipt uses a Release build with the
embedded JS bundle on an iPhone 17 Simulator.

- [x] Independent public package versions with compatibility-range validation.
- [x] Stale React Native package resolution and clean packed-consumer evidence.
- [x] Complex binary first slice: nested maps, recursive references, options,
      sets, tuples, and data enums with bounded readers/writers.
- [x] TypeScript/Rust golden byte tests, malformed-input tests, and a machine-readable
      JS benchmark receipt.
- [x] Shared recursive codec IR and explicit `x-rustra-variant-order` metadata;
      TS generators now share one recursive IR and both TS/C++ paths consume the
      explicit stable variant keys.
- [x] Generated C++ complex marshalling for native-safe schemas; Set and
      int64/uint64 commands intentionally remain on the JS complex codec path.
- [x] Android release complex-command runtime receipt on a physical arm64
      device; package/build and packed-consumer checks remain separate evidence.
- [x] iOS device-target generic Debug build after regenerating the Rust archive
      for `aarch64-apple-ios`.
- [x] iOS Simulator runtime receipt on iPhone 17 Simulator using the Release
      embedded JS bundle; codec, complex command, channel/resource, JSI, and
      benchmark markers completed.
- [x] Public bigint ergonomics and range validation for complex integer schemas
      wider than JavaScript's safe-number range.

### Final evidence receipt

- Android release APK: `examples/react-native-calculator/android/app/build/outputs/apk/release/app-release.apk`, SHA-256
  `5543c4058a16907b3161e7322baa2d48926ab6f7cbfcaba0d0c7605dd5dc15f9`.
- Physical device: `HA2D6EMP` / `TB710FU`, Android SDK 36, `arm64-v8a`.
- Device log receipt: all legacy adapters, `echoGroups` nested map/vector,
  channel ordering/drop, resource close/not-found, and benchmark completed;
  no `Benchmark failed` or `FATAL EXCEPTION` was observed.
- iOS generic build: `xcodebuild ... -sdk iphoneos -destination
'generic/platform=iOS' ... CODE_SIGNING_ALLOWED=NO -jobs 1 build` succeeded
  after the vendored archive was rebuilt as a non-fat `arm64` device archive.
- iOS Simulator runtime: the Release app built, installed, and launched on
  iPhone 17 Simulator (`99B087B5-DEF6-4CF1-9177-81A5DE564CFC`); logs confirmed
  all codec variants, `echoGroups`, channel ordering, resource post-close
  behavior, JSI installation, and benchmark output with no `Benchmark failed`,
  `No script URL`, or `FATAL EXCEPTION` marker.
- Packed consumer: the CLI tarball explicitly includes `dist/codec-ir.*`, the
  `@rustra/types` tarball includes `dist/complex-codec.*`, and
  `bun run verify:consumer:react-native` imports `createComplexCodec` from the
  packed dependency before checking native source resolution.
- Default local iOS archive: restored to the Simulator slices after the device
  link receipt. Reproduce the device check with
  `RUSTRA_IOS_TARGET=aarch64-apple-ios RUSTRA_PROFILE=release sh
modules/rustra-jsi/ios/build-rust-ios.sh` before a device-target build.
- Follow-up backlog: keep a packed RN native smoke in both platform CI jobs and
  publish only with explicit authorization.
- No npm or crates.io publication was performed. The working tree remains
  intentionally dirty and uncommitted.

---

## Task 1: Independent release metadata and validation

**Files:**

- Modify: `.changeset/config.json`
- Modify: `scripts/check-release-coherence.mjs`
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Modify: `Cargo.toml`
- Modify: `crates/rustra/Cargo.toml`
- Modify: `crates/rustra-macros/Cargo.toml`
- Modify: `packages/bun/package.json`
- Modify: `packages/devtools/package.json`
- Modify: `packages/node/package.json`
- Modify: `packages/react-native/package.json`
- Modify: `packages/react/package.json`
- Modify: `packages/tauri/package.json`
- Modify: `packages/testing/package.json`
- Test: `scripts/check-release-coherence.test.mjs` or the repository's established script-test location

**Interfaces:**

- Produces an independent-version coherence check that accepts different public package versions.
- Produces explicit CLI-to-Rust compatibility metadata for generated Cargo manifests.

- [ ] **Step 1: Write the failing validator fixtures**

Create a temporary test fixture or test helper that changes one adapter package
version while keeping its `@rustra/types` range valid, and assert the validator
accepts it. Add a second fixture with an incompatible types range and assert a
failure naming both packages and the invalid range.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run `bun test scripts/check-release-coherence.test.mjs` (or the selected
repository test command). It must fail because the current validator still
requires the fixed group and exact versions.

- [ ] **Step 3: Remove exact lockstep assumptions**

Change Changesets configuration so public packages are not one fixed group.
Replace exact version comparisons with checks for package-local versions,
valid internal dependency ranges, lockfile manifest versions, and the CLI's
explicit Rust compatibility range. Keep the Rust macro/core pair check where
Cargo requires it and exclude unpublished examples from the public release
set.

- [ ] **Step 4: Make generated Rust compatibility explicit**

Replace the CLI's version-derived `rustraTemplate.cargoMinor` contract with a
named compatibility field/range. Update generated template assertions and
fixtures so a newer CLI can generate a project against a compatible Rust pair
without requiring the CLI npm version to equal the crate version.

- [ ] **Step 5: Run the focused validator and release checks**

Run `bun test scripts/check-release-coherence.test.mjs`,
`bun run test:release-coherence`, and `bunx changeset status`. Confirm that the
existing RN changeset does not implicitly bump unrelated packages.

- [ ] **Step 6: Commit the release-boundary change**

```bash
git add .changeset/config.json scripts/check-release-coherence.mjs package.json packages/*/package.json packages/cli/src packages/cli/package.json Cargo.toml crates/rustra/Cargo.toml crates/rustra-macros/Cargo.toml scripts/check-release-coherence.test.mjs
git commit -m "feat(release): allow independent package versions"
```

## Task 2: Packed React Native consumer gates and resolver diagnostics

**Files:**

- Modify: `scripts/check-react-native-package.mjs`
- Modify: `packages/cli/src/react-native.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `scripts/check-packed-react-native-consumer.mjs`
- Test: `packages/cli/src/generate.test.ts`, packed consumer script

**Interfaces:**

- Produces a clean packed adapter consumer build check for Android and iOS jobs.
- Produces resolver diagnostics that distinguish missing, stale, incomplete, and selected adapter packages.

- [ ] **Step 1: Add failing stale-package tests**

Extend the resolver fixture with a complete app-local package whose native files
have a different package marker/version from the valid hoisted package. Assert
that generation chooses the package matching the requested adapter version or
fails with an actionable stale-package message.

- [ ] **Step 2: Run the focused CLI test and verify it fails**

Run `bun run --cwd packages/cli test -- generate.test.ts`. It must expose that
file presence alone cannot distinguish a complete but stale package.

- [ ] **Step 3: Implement package identity validation**

Read the candidate package manifest, verify the package name and requested
adapter version/range, and include the selected absolute native root in a
diagnostic generated comment or check output. Preserve the dry-run fallback
when installation has not happened yet.

- [ ] **Step 4: Add packed consumer verification**

Pack `@rustra/react-native` and its generated module into a clean temporary
consumer, install from the archive, run codegen, and verify that native source
paths resolve from the installed package. The script must fail if it silently
uses a workspace source path.

- [ ] **Step 5: Wire native CI jobs to the packed fixture**

Run the packed check before Expo prebuild in `rn-android` and `rn-ios`, and keep
the existing local workspace smoke as a separate source-development check.

- [ ] **Step 6: Verify and commit**

Run the focused CLI tests, `bun run verify:package:react-native`, and the
consumer script. Commit only after the generated fixtures and CI YAML pass
syntax/format checks.

## Task 3: Shared schema codec IR and explicit enum metadata

**Files:**

- Create: `packages/cli/src/codec-ir.ts`
- Modify: `packages/cli/src/generate.ts`
- Modify: `packages/cli/src/schema.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `crates/rustra/src/schema.rs`
- Modify: `crates/rustra/src/lib.rs`
- Test: `packages/cli/src/codec-ir.test.ts`, `crates/rustra/src/schema.rs` tests, schema fixture files

**Interfaces:**

- `buildCodecIr(schema: PackageSchema): CodecPackageIr` returns recursively typed nodes with stable field and variant order.
- `CodecPackageIr` exposes command route eligibility and exact unsupported reasons.
- Rust schema output includes explicit `x-rustra-variant-order` metadata for supported enum definitions.

- [x] **Step 1: Add failing IR tests for complex fixtures**

Use fixtures containing a nested struct, `Record<string, Nested>`, an option of
a collection, and a data enum. Assert the IR preserves declaration order,
resolves references, and reports no unsupported reason for the target complex
route. Add a fixture with a recursive cycle beyond the configured depth and
assert a bounded diagnostic.

- [x] **Step 2: Run the IR tests and verify they fail**

Run `bun test packages/cli/src/codec-ir.test.ts`. The current generator has no
shared recursive IR and must fail to provide the expected route/metadata.

- [x] **Step 3: Implement the recursive IR**

Add explicit node types for scalar, bytes, string, option, sequence, set, map,
tuple, struct reference, and enum variant payloads. Track a visited reference
stack and a maximum depth. Return structured unsupported reasons rather than a
boolean.

- [x] **Step 4: Emit and validate enum order metadata**

Extend the Rust schema envelope with an explicit variant-order extension where
the runtime can prove it. Update CLI schema parsing and identifier validation
to accept only the expected metadata shape. Reject data enums without this
metadata from the complex route instead of guessing.

- [x] **Step 5: Migrate postcard classification to the IR**

Use the IR to decide whether a command uses the unchanged postcard route,
complex route, or Tier 3. Keep the old postcard support set and byte fixtures
green.

- [x] **Step 6: Run Rust and CLI tests and commit**

Run `bun test packages/cli/src/codec-ir.test.ts packages/cli/src/generate.test.ts`
and `cargo test -p rustra`. Commit the IR independently from codec emission.

## Task 4: Rust complex codec

**Files:**

- Create: `crates/rustra/src/complex_codec.rs`
- Modify: `crates/rustra/src/lib.rs`
- Modify: `crates/rustra/src/rkyv_codec.rs`
- Test: `crates/rustra/src/complex_codec.rs` tests and golden fixtures under `crates/rustra/tests/fixtures/`

**Interfaces:**

- `complex_encode(schema: &Value, definitions: &Value, value: &Value, limits: CodecLimits) -> Result<Vec<u8>>`
- `complex_decode(schema: &Value, definitions: &Value, bytes: &[u8], limits: CodecLimits) -> Result<Value>`
- `CodecLimits { max_depth: usize, max_payload_bytes: usize, max_collection_len: usize }`

- [ ] **Step 1: Write failing Rust golden tests**

Cover nested structs, struct-valued maps with sorted keys, data enums with
payloads, option/collection nesting, malformed length prefixes, duplicate map
keys, and configured limits. Assert exact bytes for at least one fixture and
serde Value round trips for all fixtures.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run `cargo test -p rustra complex_codec`. The module and functions must be
absent or fail the new byte/round-trip assertions.

- [ ] **Step 3: Implement bounded writer and reader primitives**

Implement checked cursor operations, scalar tags, bounded lengths, UTF-8
validation, and recursion accounting. Return `RustraError::invalid_args` for
malformed input and never allocate from an untrusted length without checking
the configured limits.

- [ ] **Step 4: Implement recursive schema/value encoding and decoding**

Walk the IR-compatible JSON Schema nodes, sort map keys by UTF-8 bytes, emit
struct fields in schema order, and use explicit enum metadata for variant
indexes. Preserve JSON values sufficiently for `serde_json::from_value` to
invoke the typed handler.

- [ ] **Step 5: Route eligible commands through the complex handler**

Add a command route that serializes typed input to `Value`, decodes the complex
request, invokes the typed handler, serializes the typed output to `Value`, and
encodes the complex response. Keep Tier 3 for routes rejected by IR validation.

- [ ] **Step 6: Run the full Rust verification**

Run `cargo test -p rustra`, `cargo test --workspace`, and `cargo clippy -p
rustra -p rustra-macros --all-targets -- -D warnings`.

## Task 5: Generated TypeScript complex codecs

**Files:**

- Modify: `packages/cli/src/generate.ts`
- Modify: `packages/types/src/index.ts` only if the route metadata requires a public type
- Test: `packages/cli/src/generate.test.ts`, generated fixture tests under `examples/calculator/ts/`

**Interfaces:**

- Generated complex codecs implement the existing `RkyvV2Codec` interface with the same request/response envelope and a route marker.
- Generated encode/decode helpers use the IR node recursion and enforce the same limits as Rust.

- [ ] **Step 1: Add failing generated-byte tests**

Generate codecs for the complex fixture and assert request bytes, response bytes,
map key ordering, enum variant selection, round trips, and malformed input
errors. Assert the registry contains the complex command and excludes only
unsupported commands with a reason.

- [ ] **Step 2: Run the focused generated tests and verify failure**

Run the CLI generator test file and confirm the current generator either emits
Tier 3 or omits the command.

- [ ] **Step 3: Emit TypeScript recursive helpers**

Generate bounded reader/writer helpers from the IR. Reuse the existing UTF-8
and `encodeInto` primitives where wire-compatible, but do not use the postcard
helpers for complex tags or lengths.

- [ ] **Step 4: Add route metadata and registry selection**

Generate `complex` codecs beside postcard codecs, select one complete route per
command, and include exact route/reason comments in generated output.

- [ ] **Step 5: Verify Node/Bun compatibility**

Run `bun run --cwd packages/cli test`, `bun run test:compat`, and the generated
calculator fixture tests under both Node and Bun where supported.

## Task 6: Generated C++ React Native complex path

**Files:**

- Modify: `packages/cli/src/generate.ts`
- Modify: `packages/react-native/native/cpp/rustra-codec.hpp` only for shared safe primitives
- Test: generated C++ fixture compilation and React Native native build jobs

**Interfaces:**

- Generated C++ uses the same complex wire bytes and command route metadata as TypeScript.
- JSI marshal helpers reject malformed values and preserve map/enum/collection semantics.

- [x] **Step 1: Add failing C++ fixture assertions**

Generate C++ for the complex schema and assert the source contains complete
encode/decode functions, explicit enum tables, sorted map handling, and no
Tier 3 stub for the eligible command. Compile the fixture with the existing
native test harness.

- [x] **Step 2: Implement C++ recursive writer/reader emission**

Emit checked primitives and recursive field functions from the same IR. Convert
JSI arrays, objects, sets, ArrayBuffers, and tagged enum objects explicitly;
reject unsupported runtime values with a descriptive exception.

- [ ] **Step 3: Add packed RN native smoke**

Run the generated module against the packed adapter in Android and iOS CI and
verify a complex command fixture reaches the native handler boundary.

- [ ] **Step 4: Run native and workspace verification**

Run the focused generated tests, `bun run verify:package:react-native`, and the
available Android/iOS native build gates.

## Task 7: Performance, DX, and documentation receipts

**Files:**

- Modify: `package.json`
- Create: `scripts/complex-codec-bench.mjs`
- Modify: `examples/calculator/ts/transport-bench.test.ts`
- Modify: `docs/getting-started.md`
- Modify: `docs/internal/testing.md`
- Modify: `docs/release-procedure.md`
- Modify: `packages/cli/src/index.ts` and doctor implementation files
- Test: benchmark gate, doctor tests, docs/codegen fixture checks

**Interfaces:**

- `bun run bench:complex` emits a machine-readable receipt with payload shape, route, bytes, encode/decode timings, and allocation mode.
- `rustra doctor` reports missing tools and actionable remediation without assuming `rustup` is on PATH.

- [ ] **Step 1: Add failing benchmark receipt tests**

Assert that representative simple and complex fixtures produce receipts with
route and payload metadata, and that a missing baseline is reported as
unverified rather than a passing performance claim.

- [ ] **Step 2: Implement the benchmark matrix and DX diagnostics**

Add the complex benchmark command and improve doctor tool discovery/error
messages. Keep simulator, physical-device, build, and runtime evidence labels
separate.

- [ ] **Step 3: Update type matrix and release procedure**

Document postcard, complex binary, and JSON fallback eligibility, independent
version compatibility, packed consumer checks, and receipt requirements. Mark
stale simulator/CI statements with current evidence or remove them.

- [ ] **Step 4: Run final verification**

Run `bun run build`, `bun run lint`, `bun run format:check`, `bun run test`,
`bun run test:compat`, `cargo test --workspace`, `bun run bench:complex`, and
the packed RN consumer checks. Review `git diff --check` and generated fixture
stability.

- [ ] **Step 5: Create the release receipt without publishing**

Record package versions, changesets, tarball hashes, CI/native gates,
codec-golden results, benchmark receipt paths, and known unverified physical
runtime claims. Leave registry publication for explicit authorization.
