# Ordinary Function Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete ordinary Rust function registration, generated positional TypeScript and correct efficient binary execution.

**Architecture:** An arity-marked safe Fn adapter reuses the existing command handler and dispatch guards. Optional command metadata selects positional TS signatures; root-aware codecs preserve the native return shape and typed caller-buffer path.

**Tech Stack:** Rust, Serde, Schemars, Postcard, TypeScript, Bun/Node, generated C++.

**Spec:** `docs/specs/2026-09-16-function-registration.md`

## Global Constraints

- Work only in `.worktrees/function-registration`, branch `codex/function-registration`, based on `1f277de2e68e2242b7a6503e6e0ab731833e60e3`.
- No new unsafe production code, C ABI, async registration, source parser, remote publication or 1.0 claim.
- Handler/mapper `Send + Sync + 'static`; argument `DeserializeOwned + JsonSchema + 'static`; output `Serialize + JsonSchema + 'static`.
- Zero through twelve arguments; metadata `functionArgs: number`, omitted for legacy commands.
- Keep legacy command wire/schema/hash behavior; explicit `try_function` mapper.

### Task 1: Function registration and compatible generated codecs

**Files:** Rust function adapter and builder modules under `crates/rustra/src/`; command metadata in `command_types.rs`, `command_build.rs`, `package_schema.rs`; Rust emitter `package_commands_gen.rs`; root support `frame_support.rs`; TS schema validation and generation under `packages/cli/src/`; live-schema codec under `packages/types/src/`; focused Rust/TS tests and package test-list wiring.

**Interfaces:**

- Produce `PackageBuilder::function(name, handler)` and `::try_function(name, handler, map_error)` with inferred tuple argument marker, following the spec.
- Produce command schema `functionArgs: 0..12`; this is included in `command_schema_entry`, hence both schema and wire signatures. For arity > 0 require fixed tuple input schema of matching length; arity 0 requires null/unit schema.
- Emit `export function add(arg0: Input[0], arg1: Input[1], options?: InvokeOptions): Promise<Output>` dispatching `[arg0, arg1]`; zero args dispatch explicit `null` with unit normalization at the relevant codec boundary.
- Root tuple postcard has no length byte. Root unit has no body. Root scalar is one scalar. Existing object schema stays a named-field codec.

- [x] Write failing tests using ordinary functions, e.g.:

```rust
fn add(a: i32, b: i32) -> i32 { a + b }
let pkg = Package::builder("test.functions").function("add", add).build();
assert_eq!(pkg.invoke_json("add", serde_json::json!([2, 3])).unwrap(), serde_json::json!(5));
assert_eq!(pkg.live_schema()["commands"][0]["functionArgs"], 2);
```

- [x] Verify failure before adding the adapter. Use `cargo test -p rustra --test function_registration` with task-local target/cache as needed.
- [x] Implement the adapter, metadata, both public emitters and validators. Use the approved bounds and explicit fallible mode. Add tests for 0/1/2/4/12 arguments, nested tuples, unit arguments, closures, return shapes, error mapping, duplicate registration and compile rejection of unsafe wrappers.
- [x] Add cross-route root fixtures in the existing TS tests before changing codec routing. Pin `add(2,3)` request bytes to `[1,0,4,6]`; a success response carrying `5i32` is `[1,0,0,0,0,0,0,0,10]`. A unit success is the eight-byte header and decodes to `undefined`.
- [x] Implement root-aware postcard field access for static TS, Rust support and generated C++. Keep the complex fallback for unsupported roots. Update live-schema null/root agreement. Generate direct reusable cursor encoding for primitive root tuples. Do not add raw native function routes or reuse the NaN fallback sentinel for root numeric returns.
- [x] Ensure schema-diff/function metadata differences are visible and legacy command metadata remains absent. Test generated TypeScript compile and C++ compile if harness available.
- [x] Run focused tests, CLI/types builds and relevant existing generator tests. Self-review and record test commands/results. Prepare a scoped diff; the controller will manage commits to avoid shared-index conflicts.

### Task 2: Executable cross-language and performance proof

**Files:** Create `crates/rustra/examples/function_fixture.rs`, `crates/rustra/benches/function_dispatch.rs`, `crates/rustra/tests/function_allocations.rs`, `scripts/function-registration-integration.ts`; modify crate bench declarations and root package test/bench scripts as needed.

**Interfaces:** Consume Task 1 `.function`/`.try_function`, metadata and generated frame codecs; invoke the current Rust package through a small task-owned fixture process using hex request/response frames. Outputs remain local test artifacts, not published packages.

- [x] Build one fixture package with `add(i32,i32)->i32`, `reset()->()`, `greet(String)->String`, nested tuple, `Option<i32>`, `Vec<i32>`, struct/map return and a domain error mapped to `RustraError`. Emit its real schema for CLI generation.
- [x] Generate TS from that schema, load actual generated codecs/wrappers against current types source/build, encode requests, run them through Rust and assert decoded results. Check malformed input/error and fallback once-only behavior. Compare `encode` and reusable `encodeInto` bytes.
- [x] Add a focused allocation counter test around a warmed `invoke_frame_into` with stack request/response buffers; counting must exclude package construction, output assertions and harness work. Assert zero allocations and exactly one handler invocation. Test an exactly eight-byte unit response buffer.
- [x] Benchmark equivalent work through ordinary function and legacy struct command using `black_box`. Include JSON, `invoke_frame`, `invoke_frame_into`; verify equal outputs outside measurement. Use Criterion warmup/measurement parameters suitable for repeatable short local runs and record CPU/toolchain/source identity.
- [x] Run the integration command and benchmark, inspect any regression before making claims. Separate wire/host-process evidence from RN or real-device evidence.

### Task 3: Documentation, release note and final validation

**Files:** Paired English/Korean authoring docs under `docs/`, additive `.changeset/` note, `api-surface/snapshot.json`, this plan's status and a concise verification/performance report under `docs/research/`.

**Interfaces:** Document exactly `.function("add", add)`, `.try_function("read", read, map_error)`, `add(arg0,arg1,options?)`, 0..12 arity, ownership/serde bounds and synchronous scope. Preserve existing macro documentation.

- [x] Add an executable minimal authoring example and the generated TS call. Explain argument-name reflection, fallible errors and source/host verification limits without suggesting 1.0 is complete.
- [x] Add an additive release note; no version bump/publication. Update the API surface snapshot after source additions are final.
- [x] Run `cargo test -p rustra --locked`, CLI/types test and build scripts, `bun run test:api-surface`, `bun run test:architecture`, formatting/docs checks appropriate to changed files, and the cross-language integration test. Broaden only for unresolved risks.
- [x] Obtain an independent whole-branch review of spec compliance and code quality, fix blockers and rerun affected tests.
- [x] Record measured results and concrete remaining platform proof boundaries. Keep feature work isolated and ready for review; no push/merge/publish without an explicit request.

## Completion

Implemented and validated on 2026-09-16 KST in the isolated feature worktree. See `docs/research/2026-09-16-function-registration-verification.md` and its JSON receipt for commands, measured scope, source fingerprints and platform boundaries. Source review and scoped correction review passed; no open blocker. Changes remain local and uncommitted; no merge, push or publication.

## User-requested continuation: examples and iOS Simulator

The user requested applying the approved API to runnable examples and diagnosing/improving it in a Simulator. Continue in this worktree, preserving the earlier validated source boundary in its dated receipt.

### Task 4: Preserve calculator code generation with ordinary functions

- [x] Add support for ordinary positional primitive arguments and scalar/unit returns to the calculator's example-only UniFFI mirror renderer. Preserve legacy generated output and fail closed for unsupported shapes. Test real generated Rust source compilation where possible.
- [x] Keep ownership limited to `examples/calculator/src/uniffi_render.rs` and a small helper module/tests if needed; controller owns generated artifacts, app and calculator registrations.

### Task 5: Runnable ordinary-function example and Simulator evidence

- [x] Append ordinary `add`, `greetPerson`, `safeDivide`, `remember`, `readRemembered`, `reset` registrations to the existing calculator, keeping legacy command IDs. Demonstrate 0/1/2 args, scalar/string/unit output, domain error mapping and stateful closures.
- [x] Expose a `functions` mode in the RN example and use the ordinary API in its minimal app. Show readable results and errors, run an actual-native self-check, and compare generated call/encoding routes in Release with fresh receipts.
- [x] Regenerate affected clients/native codecs through the normal generator; typecheck and validate affected Rust/codegen tests.
- [x] Build and install the current worktree's app on the available iPhone 17 iOS Simulator. Verify current fingerprint, generated calls, unit side effects and mapped error; inspect one targeted UI state. Diagnose and fix observed defects, then rerun affected evidence.
- [x] Record exact build/app/Simulator/source identities and repeated fresh runtime receipts; get independent review. No commit/merge/push/publication is implied.

Continuation completed: actual RN example and arm64 iPhone 17 / iOS 26.2 Release Simulator verified. See `docs/research/2026-09-16-function-simulator.md`. Independent implementation and final claims review passed, open findings 0. Ordinary UniFFI mirrors use JSON semantics because JSON schema does not uniquely identify postcard types. Local uncommitted work remains in this worktree.
