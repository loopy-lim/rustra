# Rustra Architecture Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 책임별 모듈 분리와 자동 architecture boundary 검사를 추가해 Rustra의 큰 파일과 중복 구현이 다시 커지지 않게 한다.

**Architecture:** 기존 public facade와 wire contract는 유지하고 내부 구현을 Rust core, shared TypeScript runtime, CLI watcher 단위로 이동한다. 공용 helper를 먼저 고정한 뒤 각 소비자를 re-export facade로 연결하며, line budget보다 import/dependency/duplicate rule을 우선하는 구조 검사를 둔다.

**Tech Stack:** Rust workspace, Rust proc-macro, TypeScript NodeNext, Bun test, Cargo test, C++ generated codec tests.

**Spec:** `docs/superpowers/specs/2026-08-29-architecture-decomposition-design.md`

## Global Constraints

- 버전 필드와 package/Cargo release version은 변경하지 않는다.
- public import path와 generated wire bytes는 유지한다.
- `RendererHost`는 삭제하지 않고 호환 가능한 deprecated/doc-hidden 정책을 사용한다.
- adapter 간 직접 의존을 만들지 않는다.
- 각 구현 단계는 failing test를 먼저 추가하고 focused test를 통과시킨다.
- 이번 작업에서는 commit, push, publish를 수행하지 않는다.

---

### Task 1: Architecture boundary checker

**Files:**

- Create: `scripts/architecture-boundaries.mjs`
- Create: `scripts/architecture-boundaries.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces `checkArchitectureBoundaries({ root }) -> { errors, warnings }` and a
  `bun run test:architecture` command.

- [ ] **Step 1: Write failing boundary tests**

  Assert the current intended rules: one shared JSON engine, no RN private
  `raceAbortShallow`/UTF-8 implementation, one naming implementation in Rust, no
  watcher timer in `index.ts`, and all facade line budgets.

- [ ] **Step 2: Run `bun test scripts/architecture-boundaries.test.ts` and observe failure**

- [ ] **Step 3: Implement the checker with stable, path-specific diagnostics**

- [ ] **Step 4: Add `test:architecture` to the root `package.json` scripts and run the focused test**

### Task 2: Shared naming crate

**Files:**

- Create: `crates/rustra-naming/Cargo.toml`
- Create: `crates/rustra-naming/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `crates/rustra/Cargo.toml`
- Modify: `crates/rustra-macros/Cargo.toml`
- Modify: `crates/rustra/src/codegen.rs`
- Modify: `crates/rustra-macros/src/lib.rs`

**Interfaces:**

- Produces `rustra_naming::snake_to_lower_camel(&str) -> String`.

- [ ] **Step 1: Add a failing shared naming integration test covering `_`, leading, and already-camel names**
- [ ] **Step 2: Run the test and confirm the new crate/function is absent**
- [ ] **Step 3: Implement the tiny dependency and replace both private copies**
- [ ] **Step 4: Run `cargo test -p rustra-naming -p rustra -p rustra-macros`**

### Task 3: Rust core codegen and package extraction

**Files:**

- Create: `crates/rustra/src/codegen/mod.rs`
- Create: `crates/rustra/src/codegen/types.rs`
- Create: `crates/rustra/src/codegen/commands.rs`
- Create: `crates/rustra/src/codegen/contract.rs`
- Create: `crates/rustra/src/command.rs`
- Create: `crates/rustra/src/registry.rs`
- Create: `crates/rustra/src/package.rs`
- Create: `crates/rustra/src/invoke.rs`
- Modify: `crates/rustra/src/lib.rs`
- Modify: `crates/rustra/src/lib.rs` module declarations and module-local tests that move with their implementation

**Interfaces:**

- `lib.rs` remains the public facade.
- `Package`, `PackageBuilder`, `GeneratedPackage`, `Command`, and existing public
  traits keep their existing paths.

- [ ] **Step 1: Add compile/API tests that import public types through `rustra` and assert generated output equality**
- [ ] **Step 2: Run the focused Rust tests before moving implementation**
- [ ] **Step 3: Move codegen emitters behind `codegen::*` and command/registry/invoke internals behind their modules**
- [ ] **Step 4: Keep `pub use`/private `use` wiring in `lib.rs` explicit, update module declarations, and remove imports made dead by the moves**
- [ ] **Step 5: Run `cargo test -p rustra --lib --tests` and the architecture checker**

### Task 4: TypeScript runtime split

**Files:**

- Create: `packages/types/src/public.ts`
- Create: `packages/types/src/errors.ts`
- Create: `packages/types/src/utf8.ts`
- Create: `packages/types/src/cancel.ts`
- Create: `packages/types/src/json-engine.ts`
- Create: `packages/types/src/live-schema.ts`
- Create: `packages/types/src/rkyv-engine.ts`
- Create: `packages/types/src/global.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/react-native/src/index.ts`
- Delete: `packages/react-native/src/utf8.ts` only after all consumers use the shared module
- Modify: corresponding tests

**Interfaces:**

- `packages/types/src/index.ts` remains the package entrypoint.
- Existing exports (`EngineClient`, `RustraCommandError`, `createJsonEngine`,
  `createRkyvV2Engine`, global invoke functions) remain source-compatible.
- RN imports shared `encodeUtf8`, `decodeUtf8`, `exactArrayBuffer`, and cancel helper.

- [ ] **Step 1: Add export-surface and behavior tests for each extracted module**
- [ ] **Step 2: Run focused tests and verify the new imports fail or are missing**
- [ ] **Step 3: Extract errors/UTF-8/cancel without changing behavior**
- [ ] **Step 4: Extract JSON/live-schema/rkyv/global sections and leave index re-exports**
- [ ] **Step 5: Remove RN duplicate helpers and run all types/RN/adapter tests**

### Task 5: CLI watcher unification

**Files:**

- Create: `packages/cli/src/watch.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/dev.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `packages/cli/src/dev.test.ts`

**Interfaces:**

- `createWatchLoop` and `createFileWatch` own timer, queue, dispose, and event filtering.
- `runWatch` and `runDev` only provide `perform` and dirty predicates.

- [ ] **Step 1: Add a failing test proving `runWatch` returns/disposes its watcher and coalesces queued changes**
- [ ] **Step 2: Implement `watch.ts` and move both watcher paths to it**
- [ ] **Step 3: Remove direct watcher timers from `index.ts` and verify no duplicate loop remains**
- [ ] **Step 4: Run all CLI tests and `bun run test:architecture`**

### Task 6: Remaining correctness and compatibility cleanup

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/react-native/src/index.ts`
- Modify: `crates/rustra/src/renderer_host.rs`
- Modify: `doctor.config.json` only if the installed React Doctor CLI supports an equivalent explicit config path; otherwise retain the auto-discovered filename and document the naming boundary
- Create: `.changeset/<descriptive-name>.md`
- Modify: related focused tests

**Interfaces:**

- Missing argument paths reject/throw without direct process exit.
- `createChannel` validates the returned handle.
- RendererHost remains importable but is clearly deprecated.
- Changeset records release coordination without changing versions.

- [ ] **Step 1: Add failing tests for process-exit-free validation and invalid channel handles**
- [ ] **Step 2: Implement the minimal fixes, deprecate `RendererHost` without deleting it, and retain `doctor.config.json` unless an explicit React Doctor config migration is verified**
- [ ] **Step 3: Add the no-version-bump changeset and test release metadata**
- [ ] **Step 4: Run focused CLI/RN/Rust tests**

### Task 7: Full verification and audit receipt

**Files:**

- Modify: `docs/development-hurdles.md`
- Modify: `thoughts/shared/research/2026-08-29_20-56-04_architecture-review.md`

- [ ] **Step 1: Run `bun run build`, `bun run test:architecture`, package tests, and `cargo test --workspace`**
- [ ] **Step 2: Run generated TypeScript, C++ codec, React Doctor, and package dry-run checks**
- [ ] **Step 3: Run Rust Criterion and JS performance suites**
- [ ] **Step 4: Record exact receipts, current version invariants, and any physical-device proof boundary**
- [ ] **Step 5: Confirm no version field, commit, push, or publish occurred**
