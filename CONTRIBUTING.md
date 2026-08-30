English | [한국어](./CONTRIBUTING.ko.md)

# Contributing Guide

This guide describes how to contribute to rustra.

---

## Development Environment Setup

### Requirements

- Rust (edition 2024, resolver 3)
- Node.js 18+
- Bun
- Cargo workspace support

### Initial Setup

```bash
git clone <repo-url> && cd rustra-bridge

# Rust 빌드 확인
# (--workspace 는 default-members 를 무시하므로 macOS 전용 tauri-calculator 까지 빌드된다)
cargo build --workspace

# 전체 테스트 실행
cargo test --workspace
bun run test:compat
```

---

## Understanding the Project Structure

Before contributing, read the following documents:

1. [Architecture Overview](docs/architecture.md) — overall structure and core concepts
2. [Crate and Package Structure](docs/internal/crate-structure.md) — responsibilities and dependencies of each crate/package
3. [Testing Structure](docs/internal/testing.md) — test layers and run commands

---

## Development Workflow

### 1. Create a Branch

```
main → feature/짧은-설명
     → fix/짧은-설명
```

### 2. Make Code Changes

When changing Rust code:

```bash
# Rust 테스트
cargo test --workspace

# 생성된 TS 갱신 (calculator 예시)
cargo run -p rustra-calculator-example --bin rustra-calculator-example

# 전체 호환성 테스트
bun run test:compat
```

When changing TypeScript packages:

```bash
# 어댑터 테스트
bun run test:adapters

# 런타임 테스트
bun run test:runtime
```

### 3. Commit

Write commit messages centered on the **reason** for the change:

```
feat: add tuple type support in TS codegen

fix: handle null args in rustra_dispatch

docs: add debugging guide to contributing

refactor: extract command name resolution into shared function
```

### 4. Create a PR

- Keep the PR title within 70 characters and summarize the change
- In the PR body, explain **what** changed and **why** it is needed
- Verify that `bun run test:compat` passes

---

## Testing

### Test Layers

```
cargo test          ← Rust 단위 테스트 (필수)
    ↓
bun run test:ts:node  ← TS 타입 검증 (필수)
    ↓
bun run test:adapters ← 어댑터 동작 검증 (필수)
    ↓
bun run test:runtime  ← 실제 Rust↔TS 실행 (필수)
    ↓
bun run test:compat   ← 전체 통합 (PR 필수)
```

### Rust Tests

```bash
cargo test --workspace
```

### TypeScript Tests

```bash
# 전체
bun run test:compat

# 개별
bun run test:ts:node
bun run test:ts:bun
bun run test:adapters
bun run test:runtime:node
bun run test:runtime:bun
bun run test:runtime:tauri
```

### Test File Locations

| File                                                | Role                                      |
| --------------------------------------------------- | ----------------------------------------- |
| `crates/rustra/tests/public_authoring_api_tests.rs` | Rust public API tests (10)                |
| `examples/calculator/tests/example_contract.rs`     | End-to-end contract test (1)              |
| `examples/calculator/ts/generated-client.test.ts`   | TS client behavior (2)                    |
| `examples/calculator/ts/adapter-compat.test.ts`     | 4-adapter compatibility (6)               |
| `examples/calculator/ts/runtime-contract.test.ts`   | Runtime contract (2)                      |

---

## Code Conventions

### Invariants

Every change must satisfy the [compatibility contract](docs/compatibility-contract.md):

1. **Generated TS contains no host-specific imports**: `node:`, `bun:`, `@tauri-apps`, `react-native`, and `expo-modules` are forbidden
2. **Adapter packages never import each other**
3. **Adapters never import host packages directly**: the caller injects the transport
4. **`EngineClient` is the only contract**: command helpers depend only on `EngineClient`

### Rust

- Public APIs are re-exported from the `prelude` module
- The `#[command]` macro only performs signature validation and trait bound assertions (the body is an identity passthrough)
- Errors are unified under `RustraError`

### TypeScript

- Adapter packages are pure TypeScript with no external dependencies
- Only the `EngineClient` interface (`invoke<T>`) is exposed
- Only Tauri wraps `rustra_dispatch`; the others call the transport directly

---

## Debugging Guide

### When Codegen Output Looks Wrong

1. Check `schema.json` — inspect whether the JSON Schema produced by schemars matches your intent
2. Check `types.ts` — for the JSON Schema → TS type mapping rules, see the [codegen documentation](docs/internal/codegen.md)
3. Conditional JSON Schema that rustra does not generate falls back to `unknown`, and data enums or nested collections whose wire order postcard cannot prove fall back to per-command Tier 3

### Contract Hash Mismatch

`GENERATED_CONTRACT_HASH` in `contract.ts` is the SHA-256 hash of `schema.json`. If you change Rust code without regenerating TS, the hash diverges:

```bash
# 재생성
cargo run -p rustra-calculator-example --bin rustra-calculator-example

# diff로 확인
git diff generated/contract.ts
```

### When a Command Name Differs from Expectations

- `command_fn()` extracts the name from `std::any::type_name`. Debug builds may include the full path
- If you need an exact name, use `#[command(name = "myCommand")]`
- Check the actually generated name in `commands.ts`

### Adapter Test Failures

```bash
# 특정 어댑터만 실행
bun run test:adapter:tauri
bun run test:adapter:react-native

# 모킹 transport로 로깅
const engine = createNodeEngine({
  invoke(command, args) {
    console.log('invoke:', command, args);
    return mockResponse;
  },
});
```

### Tauri Runtime Debugging

When a Tauri app returns an error from `rustra_dispatch`:

1. Rust side: `RustraError` is serialized as `{ code, message }` JSON
2. TS side: `createTauriEngine` converts it into a `RustraCommandError` and throws
3. Inspect `e.code` and `e.message` in the console

### React Native Notes

- RN runtime tests are excluded from CI because they require a simulator/device
- `test:adapter:react-native` validates with a mocked transport (not real FFI)
- For FFI issues, verify that the `@_silgen_name` function name in the Swift module matches the Rust `#[unsafe(no_mangle)]` function name

---

## Releases

### Commit Hooks (lefthook)

`bun install` installs lefthook via the `prepare` script. On pre-commit, only
staged files are auto-formatted:

- `packages/*/src/**/*.ts` → `eslint --fix`
- `*.{ts,js,json,yml,md}` → `prettier --write`
- `*.rs` → `rustfmt`

The hook **does not restage**, so files that were formatted must be included
right after the commit with `git add -A <paths> && git commit --amend --no-edit`.
If you made a commit and prettier/rustfmt changes remain in the working tree,
you forgot to amend.

### Version Management (changesets)

- The current versions are determined by the Rust workspace `Cargo.toml` and each
  `packages/*/package.json`. The public `@rustra/*` packages are **independent
  release lines**, so they are not assumed to share one version.
- Breaking changes are allowed during `0.x`, so any public API change must state
  the affected packages and the bump kind in a changeset:

```bash
bun run changeset          # 대화형 changeset 작성
bunx changeset status      # 대기 중 changeset/범프 확인
```

- When a `.changeset/*.md` merges to main, the changesets action creates a
  **Version Packages PR** (or updates the existing one), and merging it updates
  the version fields and CHANGELOGs in one pass.
- Do not bump versions or tag/push arbitrarily from working source. Version bumps
  happen only through the Version Packages PR.
- npm publishing is automated by `release.yml`, and the crates.io publish job runs
  after manual approval. See the [release procedure](docs/release-procedure.md)
  for the full process.

### Release Checklist

1. `cargo test --workspace` passes
2. `bun run test:compat` passes
3. `bun run test:release-coherence` and `bunx changeset status` pass
4. Confirm the changeset is consumed and CHANGELOGs updated in the Version Packages PR
5. Tag/push following the approved release procedure
