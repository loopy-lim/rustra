English | [한국어](./CONTRIBUTING.ko.md)

# Contributing Guide

This guide describes how to contribute to rustra.

---

## Development Environment Setup

### Requirements

The user-facing prerequisites table in
[getting started](docs/getting-started.md#prerequisites) is the single source of
truth (Rust 1.88+ MSRV, Bun 1.4+, Node.js 22.x, plus the per-host native
toolchains). Only repo-development specifics are added here:

- Rust 1.88+ — the workspace MSRV (`rust-version` in the root `Cargo.toml`,
  edition 2024, resolver 3)
- Bun 1.4.0 — the exact version pinned by the root `package.json`
  `packageManager` field and installed by CI
- Node.js — published packages declare `engines.node >= 18` as the minimum
  supported runtime, while CI runs Node 22 (`setup-node` in
  `.github/workflows/ci.yml`); use 22.x locally to match CI

### Initial Setup

```bash
git clone <repo-url> && cd rustra-bridge
bun install                 # workspace deps

bun run test:fast           # first signal in ~15 s warm (first run is longer): cargo check + calculator tsc + cli unit tests

# Full battery (slower; --workspace also builds the macOS-only tauri-calculator)
cargo build --workspace
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
main → feature/short-description
     → fix/short-description
```

### 2. Make Code Changes

When changing Rust code:

```bash
# Rust tests
cargo test --workspace

# Regenerate the generated TS (calculator example)
cargo run -p rustra-calculator-example --bin generate   # contract probe: schema.json
bun run --cwd examples/calculator codegen                # render TS surfaces

# Fast dev loop: cargo check + calculator tsc + cli unit tests
bun run test:fast

# Full compatibility test
bun run test:compat
```

When changing TypeScript packages:

```bash
# Adapter tests
bun run test:adapters

# Runtime tests
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
cargo test          ← Rust unit tests (required)
    ↓
bun run test:ts:node  ← TS type validation (required)
    ↓
bun run test:adapters ← Adapter behavior validation (required)
    ↓
bun run test:runtime  ← Real Rust↔TS execution (required)
    ↓
bun run test:compat   ← Full integration (required for PRs)
```

### Which Gate When

| Command                            | When to run                                          | Checks                                                                   |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `bun run test:fast`                | every local edit loop                                | cargo check + calculator tsc + cli unit tests                            |
| `bun run test:docs`                | docs/ or docs:sync regions touched                   | en/ko mirrors, synced regions, install docs vs manifests                 |
| `bun run test:codegen-fresh`       | schema, generator, or `examples/*/generated` touched | committed generated files reproduce from current sources                 |
| `bun run test:api-surface`         | any public TS/Rust surface change                    | diff vs `api-surface/snapshot.json` (`--update` to accept intentionally) |
| `bun run test:architecture`        | module boundaries touched                            | file-size/module boundary limits                                         |
| `bun run test:release-coherence`   | versions, ranges, lockfiles touched                  | package/lockfile/range invariants                                        |
| `bun run test:release-tools`       | scripts/ or release flow touched                     | release tooling unit tests                                               |
| `bun run test:functions`           | ordinary-function registration touched               | end-to-end function registration integration                             |
| `bun run test:registry-consumer`   | host pins or consumer install path touched           | registry consumer install gate                                           |
| `bun run test:complex-codec-bench` | complex codec touched                                | codec receipt regression                                                 |

### Rust Tests

```bash
cargo test --workspace
```

### TypeScript Tests

```bash
# All
bun run test:compat

# Individually
bun run test:ts:node
bun run test:ts:bun
bun run test:adapters
bun run test:runtime:node
bun run test:runtime:bun
bun run test:runtime:tauri
```

### Test File Locations

| File                                                | Role                         |
| --------------------------------------------------- | ---------------------------- |
| `crates/rustra/tests/public_authoring_api_tests.rs` | Rust public API tests (48)   |
| `examples/calculator/tests/example_contract.rs`     | End-to-end contract test (1) |
| `examples/calculator/ts/generated-client.test.ts`   | TS client behavior (2)       |
| `examples/calculator/ts/adapter-compat.test.ts`     | 4-adapter compatibility (5)  |
| `examples/calculator/ts/runtime-contract.test.ts`   | Runtime contract (2)         |

### Docs Sync Gate

Docs that quote generated code must wrap it in `docs:sync` markers so
`bun run test:docs` can verify it byte-for-byte against the real file:

````markdown
<!-- docs:sync:begin <repo-relative path> -->

<!-- prettier-ignore -->
```ts
(quoted file body — the generated self-describing header is stripped)
```

<!-- docs:sync:end -->
````

- Layout contract: one blank line after `begin`, then `<!-- prettier-ignore -->`
  immediately followed by the opening fence; after the closing fence, one blank
  line before `docs:sync:end`. The gate fails on structural violations.
- Only `docs/` is scanned (`docs/plans/` excluded), so quoting this syntax in
  `CONTRIBUTING.md` itself cannot false-positive.
- The gate also enforces **en/ko mirror completeness**: every in-scope `X.md`
  must have its `X.ko.md` twin (and vice versa) — edit both sides in the same PR.
- Run locally: `bun run test:docs`.

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
# Regenerate
cargo run -p rustra-calculator-example --bin generate   # contract probe: schema.json
bun run --cwd examples/calculator codegen                # render TS surfaces

# Verify with a diff
git diff examples/calculator/generated/contract.ts
```

### When a Command Name Differs from Expectations

- `command_fn()` extracts the name from `std::any::type_name`. Debug builds may include the full path
- If you need an exact name, use `#[command(name = "myCommand")]`
- Check the actually generated name in `commands.ts`

### Adapter Test Failures

```bash
# Run only a specific adapter
bun run test:adapter:tauri
bun run test:adapter:react-native

# Log with a mocked transport
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

- RN runtime smoke **is** in CI: the `rn-android`/`rn-ios` jobs build a Release
  APK/app, boot an emulator/simulator, install it, and assert the app's computed
  result from the unified log (`scripts/ci-android-runtime-smoke.sh`,
  `scripts/ci-ios-runtime-smoke.sh`). The `uniffi-android`/`uniffi-ios` jobs do
  the same for the UniFFI bindings (`examples/uniffi-*-smoke`)
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

All three commands run with `stage_fixed: true`, so formatting fixes are
re-staged automatically and land in the same commit. If a hook modified files
(lefthook reports it), simply re-attempt the commit — there is no
`git add -A && git commit --amend --no-edit` ritual anymore.

### Version Management (changesets)

- The current versions are determined by the Rust workspace `Cargo.toml` and each
  `packages/*/package.json`. The public `@rustra/*` packages are **independent
  release lines**, so they are not assumed to share one version.
- Breaking changes are allowed during `0.x`, so any public API change must state
  the affected packages and the bump kind in a changeset:

```bash
bun run changeset          # Create a changeset interactively
bunx changeset status      # Check pending changesets/bumps
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
