English | [한국어](./gate-map.ko.md)

# Gate map

One page mapping every quality gate in this repository: the lefthook pre-commit
hooks, the root `package.json` gate scripts, and the GitHub Actions workflows —
what each one protects, roughly what it costs to run locally, and which checks
the `main` branch protection actually requires.

- Verified against the working tree and live branch protection on
  **2026-09-20**.
- Costs are qualitative (Fast / Medium / Slow) except where measured:
  warm-cache `cargo check --workspace` ≈ 8.4 s and `bun run test:fast` ≈ 15 s
  were measured on 2026-09-20.
- Related: [CONTRIBUTING](../CONTRIBUTING.md) (contribution flow and the
  targeted-gate table), [release procedure](./release-procedure.md) (release
  gates and required-check registration).

## Layer 1 — Pre-commit (lefthook)

Configured in `lefthook.yml`; installed by the `prepare` script on `bun install`.
Only staged files are inspected (`{staged_files}`).

| Command  | Glob                     | Runs                                       | Protects                                                  |
| -------- | ------------------------ | ------------------------------------------ | --------------------------------------------------------- |
| eslint   | `packages/*/src/**/*.ts` | `bunx eslint --fix {staged_files}`         | TS lint rules for workspace packages                      |
| prettier | `*.{ts,js,json,yml,md}`  | `bunx prettier --write {staged_files}`     | Formatting consistency (CI re-checks with `format:check`) |
| rustfmt  | `*.rs`                   | `rustfmt --edition 2024 -- {staged_files}` | Rust formatting (CI re-checks with `cargo fmt --check`)   |

Notes:

- `parallel: true` — the three commands run concurrently.
- `stage_fixed: true` on all three — files the hook rewrites are re-staged into
  the same commit automatically.
- There is **no pre-push hook** — nothing runs between a local commit and CI.
- The hook is convenience, not the gate: formatting and lint are re-verified
  server-side (`cargo fmt -- --check`, `bun run format:check`, `bun run lint`).

## Layer 2 — `package.json` gate scripts

Run every script below as `bun run <script>` from the repository root. "Protects"
describes the invariant that fails when the script fails.

| Script                         | Group             | Protects                                                                                                                     | Cost              | Local run notes                                               |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| `test`                         | umbrella          | Aggregate of release-tools, types, ts:bun, packages, cli, complex-codec-bench, bench-gate, functions unit/E2E suites         | Slow              | Not a 1:1 CI mirror — the `typescript` CI job is a superset   |
| `test:fast`                    | umbrella          | First signal: workspace compiles, calculator types check, CLI units pass                                                     | Fast (≈15 s warm) | `cargo check --workspace` ≈ 8.4 s warm is most of it          |
| `test:compat`                  | compat chain      | Full Rust↔TS compatibility matrix (ts:node + ts:bun + adapters + runtime)                                                    | Slow              | Minimum bar before opening a PR (CONTRIBUTING)                |
| `test:ts:node`                 | compat chain      | Compiled `dist-ts` example tests (calculator + crud) pass under Node `--test`                                                | Medium            | Runs `tsc` on both examples first                             |
| `test:ts:bun`                  | compat chain      | Example TS tests pass under Bun against a debug calculator binary                                                            | Medium            | Builds `rustra-calculator-example` (debug) first              |
| `test:adapters`                | compat chain      | Adapter umbrella: tauri + react-native (mocked transport) + RN example typecheck                                             | Medium            | Chains the three `test:adapter:*`/`test:app:react-native`     |
| `test:adapter:tauri`           | compat chain      | Tauri adapter behavior with a mocked transport                                                                               | Medium            | Needs a built workspace                                       |
| `test:adapter:react-native`    | compat chain      | RN adapter behavior with a mocked transport (not real FFI)                                                                   | Medium            | Needs a built workspace                                       |
| `test:app:react-native`        | compat chain      | `examples/react-native-calculator` typechecks                                                                                | Fast              |                                                               |
| `test:runtime`                 | compat chain      | Real Rust↔TS execution: node + bun + tauri example apps                                                                      | Slow              | Release builds inside                                         |
| `test:runtime:node`            | compat chain      | Node app E2E over the release FFI binary                                                                                     | Slow              | `cargo build --release` first                                 |
| `test:runtime:bun`             | compat chain      | Bun FFI app runs against the release binary                                                                                  | Slow              | Identical chain to `test:runtime:bun-ffi`                     |
| `test:runtime:tauri`           | compat chain      | Tauri example builds and passes its smoke run                                                                                | Slow              | Build + smoke of `examples/tauri-calculator`                  |
| `test:runtime:native`          | compat chain      | Native addon/FFI umbrella: node-napi + bun-ffi                                                                               | Slow              | Chains the two below                                          |
| `test:runtime:node-napi`       | compat chain      | napi debug addon builds and the Node napi app runs                                                                           | Medium            | `bun run build:napi` first                                    |
| `test:runtime:bun-ffi`         | compat chain      | Bun FFI app runs against the release binary                                                                                  | Slow              | Identical chain to `test:runtime:bun`                         |
| `test:types`                   | package units     | `@rustra/types` builds and its engine-core contract tests pass                                                               | Fast              |                                                               |
| `test:packages`                | package units     | All workspace packages build; node/bun/tauri/react-native/testing/devtools/react unit tests pass                             | Slow              | Includes the `packages/bun` FFI caller-buffer contract        |
| `test:api-surface`             | source of truth   | Public Rust/TS exports match `api-surface/snapshot.json` (drift gate)                                                        | Medium            | Compiles the `scripts/api-surface-rust` parser                |
| `test:codegen-fresh`           | source of truth   | Committed `examples/*/generated` files reproduce from current sources                                                        | Medium            | Rebuilds the CLI; run `bun run codegen` in the example to fix |
| `test:bindings-fresh`          | source of truth   | UniFFI Swift/Kotlin bindings are fresh vs the Rust crate                                                                     | Medium            | Rebuilds the CLI; regenerates bindings                        |
| `test:architecture`            | source of truth   | Module boundaries and file line caps hold                                                                                    | Fast              |                                                               |
| `test:docs`                    | source of truth   | `docs:sync` regions match generated files byte-for-byte; en/ko mirror completeness; install docs vs manifests                | Fast              | This document is in the mirror gate's scope                   |
| `test:onboarding`              | source of truth   | A new-user journey (init → doctor → codegen → demo) works in a temp dir                                                      | Medium            | Runs after `bun run build`                                    |
| `test:release-coherence`       | release integrity | Per-package versions, lockfiles, internal ranges, CLI `rustraTemplate` ranges, LICENSE, fixed groups                         | Fast              |                                                               |
| `test:release-tools`           | release integrity | Release tooling scripts' own unit tests (coherence, packed consumer, api-surface, version-packages, gates, registry, safety) | Fast              |                                                               |
| `test:registry-consumer`       | release integrity | Registry consumer gate script's unit tests                                                                                   | Fast              |                                                               |
| `verify:package:react-native`  | release integrity | RN native files exist in the publish tarball                                                                                 | Fast              |                                                               |
| `verify:consumer:react-native` | release integrity | A packed (file:) consumer resolves the RN native sources                                                                     | Fast              |                                                               |
| `verify:consumer:registry`     | release integrity | Exact published npm/crates.io versions install and run (public registry acceptance)                                          | Slow              | Network; manual — see `registry-consumer.yml`                 |
| `verify:release-gates`         | release integrity | The candidate SHA has the required green CI checks (GitHub API)                                                              | Fast              | Needs `GH_TOKEN`; same logic `release.yml` enforces           |
| `audit:prod`                   | release integrity | No npm prod-dependency vulnerabilities at high severity or above                                                             | Fast              | Network                                                       |
| `audit:registry`               | release integrity | Published registry state (exact versions, gitHead, crate SHA, checksums) is coherent                                         | Medium            | Network; post-publish audit                                   |
| `test:complex-codec-bench`     | bench receipts    | Complex codec receipt and track-b bench harness regressions                                                                  | Medium            | Unit tests of the bench scripts                               |
| `test:bench-gate`              | bench receipts    | Criterion regression-gate logic (`check-criterion-regression.mjs`) behaves as contracted                                     | Fast              |                                                               |
| `test:app:streaming`           | example apps      | Streaming example builds and its Node app runs                                                                               | Slow              | Cargo build inside                                            |
| `test:app:auth`                | example apps      | Auth example builds and its app runs                                                                                         | Slow              | Cargo build inside                                            |
| `test:app:reference`           | example apps      | Reference app runs against the crud example crate                                                                            | Slow              | Cargo build inside                                            |
| `test:functions`               | functions         | End-to-end ordinary-function registration integration                                                                        | Medium            |                                                               |
| `lint`                         | aux (CI step)     | ESLint passes for `packages/*/src`                                                                                           | Fast              | Run by the CI `typescript` job                                |
| `format:check`                 | aux (CI step)     | Prettier reports no diffs under `packages/*/src`                                                                             | Fast              | Run by the CI `typescript` job                                |
| `lint:rust`                    | aux (CI step)     | Clippy is warning-free (`-D warnings`) for all targets                                                                       | Medium            | Run by the CI `rust` job (Linux leg)                          |
| `fmt:rust:check`               | aux (CI step)     | `cargo fmt` reports no diffs                                                                                                 | Fast              | Run by the CI `rust` job (Linux leg)                          |
| `coverage:rust`                | aux (advisory)    | Coverage visibility for `rustra` + `rustra-macros`                                                                           | Slow              | Mirrors `coverage.yml` (not a gate)                           |
| `coverage:ts`                  | aux (advisory)    | Coverage visibility for the eight package unit suites                                                                        | Medium            | Mirrors `coverage.yml` (not a gate)                           |
| `bench`                        | aux (benchmark)   | Transport benchmark numbers (`bench:bun` is the same command)                                                                | Slow              |                                                               |
| `bench:complex`                | aux (benchmark)   | Complex codec benchmark numbers                                                                                              | Slow              |                                                               |
| `bench:track-b`                | aux (benchmark)   | Track-B benchmark numbers                                                                                                    | Slow              |                                                               |
| `bench:hosts`                  | aux (benchmark)   | Host (node/bun) benchmark numbers                                                                                            | Slow              |                                                               |
| `bench:functions`              | aux (benchmark)   | Function dispatch criterion bench                                                                                            | Slow              |                                                               |

Not gates (excluded above): `build`, `build:napi`, the fixers (`lint:fix`,
`format`, `fmt:rust`), `clean:*`, `changeset`, `version`, `release`, `docs:api`,
`prepare`.

### `test:local` — the "run what CI runs locally" umbrella

`test:local` mirrors the locally-runnable steps of the CI `typescript` job in
one command (added 2026-09-20):

> `bun run build` → `test:release-coherence` → `lint` → `format:check` →
> `audit:prod` → `test:ts:node` → `test:ts:bun` → `test:adapters` →
> `bun run --cwd packages/cli test` → `test:complex-codec-bench` →
> `test:bench-gate` → `test:api-surface` → `test:codegen-fresh` →
> `test:bindings-fresh` → `test:architecture` → `test:release-tools` →
> `test:registry-consumer` → `test:runtime:node` → `test:runtime:bun` →
> `test:packages` → `test:onboarding` → `test:docs`

CI-only steps not mirrored locally: react-doctor, the calculator/crud
`--noEmit` tsc checks, the bare RN fixture codegen/typecheck, and the C++
generated codec tests. Expect a slow run — it contains two full release
builds (`test:runtime:node`, `test:runtime:bun`).

## Layer 3 — GitHub Actions

### `ci.yml` — 14 jobs

Triggers: push and PRs to `main`, plus a weekly Monday cron that runs only
`rust-audit` (every other job skips via `github.event_name != 'schedule'`,
including the `gate` aggregate). PR runs cancel in-progress runs of the same
ref; main pushes never cancel.

| Job              | Protects                                                                                                                                                                                                                               | Required check (2026-09-20)                                                              | Local equivalent                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `changes`        | Path filter (dorny/paths-filter): outputs `code=false` only for docs-only PRs; forced `code=true` on every other event                                                                                                                 | not required (feeds the mobile jobs' `if` and `gate`)                                    | —                                                                                                   |
| `rust-audit`     | No actionable RUSTSEC advisories (`scripts/audit-rust.sh`; only the documented Tauri 2/GTK3 exceptions pass)                                                                                                                           | **required** (`rust-audit`)                                                              | `bash scripts/audit-rust.sh` (needs `cargo-audit`)                                                  |
| `rust-deny`      | License/ban/source policy (`deny.toml` via cargo-deny)                                                                                                                                                                                 | not required                                                                             | `cargo deny check`                                                                                  |
| `rust` (matrix)  | rustfmt + clippy + `cargo test --workspace` (+ `--release`, hot-core) on Linux; core crates on macOS/Windows; release cdylib builds                                                                                                    | **required ×3** (`rust (ubuntu-latest)`, `rust (macos-latest)`, `rust (windows-latest)`) | `cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace` |
| `rust-msrv`      | MSRV 1.88 contract: core crates check + lib tests on Rust 1.88                                                                                                                                                                         | not required                                                                             | `rustup run 1.88 cargo check -p rustra -p rustra-macros`                                            |
| `rust-wasm32`    | `rustra` compiles for `wasm32-unknown-unknown`                                                                                                                                                                                         | not required                                                                             | `cargo check -p rustra --target wasm32-unknown-unknown`                                             |
| `napi`           | napi debug addon builds and the Node napi app runs (previously untested transport path)                                                                                                                                                | not required                                                                             | `bun run test:runtime:node-napi`                                                                    |
| `typescript`     | The TS/JS surface: build, lint, format, react-doctor (100/100), `audit:prod`, tsc, example/adapters/CLI tests, codegen + bindings + api-surface + architecture + docs gates, `test:compat`, package units, C++ codec tests, onboarding | **required** (`typescript`)                                                              | `bun run test:local` (see above)                                                                    |
| `rn-android`     | RN Android Release APK builds and the emulator smoke asserts the engine marker; skips on docs-only PRs                                                                                                                                 | **required** (`rn-android`)                                                              | `bash scripts/ci-android-runtime-smoke.sh rn` (needs NDK + emulator)                                |
| `rn-ios`         | RN iOS Release build and the simulator smoke asserts the engine marker; skips on docs-only PRs                                                                                                                                         | **required** (`rn-ios`)                                                                  | `bash scripts/ci-ios-runtime-smoke.sh` (macOS, simulator)                                           |
| `uniffi-android` | UniFFI Kotlin bindings load and run on an emulator (happy + divide-by-zero error paths); skips on docs-only PRs                                                                                                                        | not required                                                                             | `examples/uniffi-android-smoke` flow (no one-command equivalent)                                    |
| `uniffi-ios`     | UniFFI Swift bindings run on an iOS simulator (same marker contract); skips on docs-only PRs                                                                                                                                           | not required                                                                             | `bash examples/uniffi-ios-smoke/build-and-run.sh`                                                   |
| `consumer-smoke` | Packed tarballs install into a clean consumer, load (ESM), and the CLI `init`→codegen→run flow works                                                                                                                                   | **required** (`consumer-smoke`)                                                          | `bun run verify:package:react-native && bun run verify:consumer:react-native` (subset)              |
| `gate`           | Aggregate: all 13 jobs above must be exactly `success`; `skipped` fails (anti silent-green) **except** the four mobile jobs' skips when path-filter-originated (docs-only PR)                                                          | **not required** (verified 2026-09-20)                                                   | `node --experimental-strip-types --test scripts/ci-gate.test.ts`                                    |

Notes:

- The `gate` aggregate job exists so branch protection _could_ require a single
  check, and it fails on skipped dependencies so a broken chain cannot read as
  green. The one exception (2026-09-20): on docs-only PRs the four mobile
  emulator jobs (`rn-android`, `rn-ios`, `uniffi-android`, `uniffi-ios`) skip
  by the `changes` path filter, and `gate` (via `scripts/ci-gate.sh`, which
  receives the event name and filter output) accepts exactly those skips. Any
  other skip still fails the gate — e.g. `consumer-smoke` skipping because
  `typescript` failed stays red. GitHub treats a skipped required check as
  satisfied, so the docs-only skip does not block merges. Since 2026-09-20 the
  live protection requires exactly `gate` — see
  [Currently required checks](#currently-required-checks).

### Other workflows

| Workflow                               | Trigger                                       | Protects                                                                                             | Required check | Local equivalent                                                                      |
| -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `release.yml`                          | CI success on main (`workflow_run`) or manual | Publish only ever happens from a green CI SHA: pins the candidate, re-checks gates before publishing | no             | `bun run verify:release-gates` (same checker)                                         |
| `miri.yml` (via release + weekly)      | workflow_call, weekly Sunday cron, manual     | UB in `rustra` unsafe/pure-logic paths (lib, frame_wire, field_order_drift)                          | no             | `bash scripts/run-safety-check.sh lib cargo miri test -p rustra --lib` (nightly)      |
| `sanitizer.yml` (via release + weekly) | workflow_call, weekly Sunday cron, manual     | Memory errors/leaks: ASan+LSan over `cargo test -p rustra --lib`                                     | no             | Same command with nightly `-Zsanitizer=address`                                       |
| `fuzz.yml` (via release + weekly)      | workflow_call, weekly Saturday cron, manual   | Frame decode path survives random input (3 targets × 10 min + seed corpus replay)                    | no             | `cargo fuzz run invoke_frame ...` (nightly, `fuzz/` crate)                            |
| `coverage.yml`                         | push to main, manual                          | Advisory only — explicitly not a gate ("가시화"): Rust llvm-cov + TS c8 summaries                    | no             | `bun run coverage:rust` / `bun run coverage:ts`                                       |
| `bench.yml`                            | push to main (path-filtered), manual          | Performance regression budget: criterion vs previous baseline, 10% threshold                         | no             | `cargo bench` then `bun scripts/check-criterion-regression.mjs --max-regression 0.10` |
| `registry-consumer.yml`                | manual only                                   | Exact published versions install and behave on macOS; receipt artifact                               | no             | `bun run verify:consumer:registry`                                                    |

`miri.yml`, `sanitizer.yml`, and `fuzz.yml` are reusable workflows: they run on
their weekly schedules **and** as mandatory dependencies of every `release.yml`
publish (see [release procedure](./release-procedure.md) prerequisites).

## Which gate when

| Situation                            | What runs                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `git commit` (automatic)       | lefthook pre-commit: eslint --fix, prettier --write, rustfmt on staged files (auto re-staged)                                                                          |
| Pre-push                             | Nothing — no pre-push hook is configured                                                                                                                               |
| Local edit loop                      | `bun run test:fast` (≈15 s warm)                                                                                                                                       |
| Targeted (docs, codegen, surface...) | CONTRIBUTING's [Which Gate When](../CONTRIBUTING.md) table (`test:docs`, `test:codegen-fresh`, `test:api-surface`, `test:architecture`, `test:release-coherence`, ...) |
| Before opening a PR                  | `bun run test:compat` minimum; add the targeted gates above for what you touched                                                                                       |
| Docs-only change                     | `bun run test:docs` (docs:sync regions + en/ko mirror — this file is in scope); the four mobile emulator CI jobs skip automatically on docs-only PRs                   |
| On main only (never a PR gate)       | `bench.yml` (path-filtered), `coverage.yml`                                                                                                                            |
| Release only                         | `miri` + `sanitizer` + `fuzz` via `release.yml`, registry-consumer (manual), `audit:registry` post-publish — see [release procedure](./release-procedure.md)           |

The mobile/emulator suites (`rn-android`, `rn-ios`, `uniffi-*`) have no
comfortable local equivalent; rely on CI for them.

## Currently required checks

**2026-09-20 (applied):** the live branch protection on `main` requires exactly
one context — `["gate"]`. It was applied on the same day the morning audit
recorded the previous state, so both states are documented here:

- **Before the switch (2026-09-20 morning):** 8 individual contexts —
  `rust-audit`, `rust (ubuntu-latest)`, `rust (macos-latest)`,
  `rust (windows-latest)`, `typescript`, `rn-android`, `rn-ios`,
  `consumer-smoke`. Under that scheme the table's "required" annotations below
  described the merge blockers directly.
- **After the switch (applied 2026-09-20, `strict: false` kept):** the single
  required context is `gate`. Because `gate` needs all 12 jobs, the
  merge-blocking set **widened** to include the previously-unrequired
  `rust-msrv`, `rust-wasm32`, `rust-deny`, `napi`, and the two `uniffi` jobs.
  The "required" column in the ci.yml table above now reads as history; every
  job in it blocks merges **through the aggregate**.

Re-verify in one step:

```bash
gh api repos/loopy-lim/rustra/branches/main/protection --jq '.required_status_checks.contexts'
```

Facts future audits should know:

- Rollback to the 8 individual contexts and the change procedure are documented
  in [release procedure](./release-procedure.md) Step 3.5.
- On docs-only PRs the mobile emulator jobs (`rn-android`, `rn-ios`,
  `uniffi-android`, `uniffi-ios`) end in the `skipped` state (the `changes`
  path filter); `gate` accepts exactly those skips, stays green, and the merge
  requirement is satisfied. Docs-only PRs still merge — by design, not a
  protection regression.
- When a CI job is added or removed, update this map **and** `gate`'s `needs`
  (plus `scripts/ci-gate.sh`) together — the aggregate is the merge contract.
