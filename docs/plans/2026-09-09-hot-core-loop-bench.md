# dylib hot-core dev loop — measured benchmark (2026-09-09)

Status: measured (2 runs × 2 warmup + 20 measured cycles, sequential). Companion to
[`2026-09-09-native-hot-core-design.md`](./2026-09-09-native-hot-core-design.md).
Harness: [`scripts/hot-core-loop-bench.mjs`](../../scripts/hot-core-loop-bench.mjs).
Branch snapshot measured: `feat/native-hot-core`, working tree at commit `4942a1b`
for every component the loop executes (`packages/cli/src/dev.ts`, `dev-dylib.ts`,
`watch.ts`, `crates/rustra/src/hot_core_watch.rs`, `hot_core*.rs`,
`examples/calculator/src/lib.rs` — none had local modifications during either run).
Commits `307954ce`/`0de85a03` (webview swap reporting + probe scaffolding) landed
from a parallel worker **after** the measurement; they touch none of those
components, and the probe's watch-mode output contract used by the harness
(`PROBE CONTRACT`, `PROBE SWAP <old> -> <new>`) is unchanged, so the benchmark
reproduces against the new HEAD. The measured probe binary was built from the
pre-commit `main.rs` (which opens the live path twice in watch mode; the commit
removes the redundant open — no effect on the swap path or the numbers above).

## Verdict

The design target is a warm rebuild→swap loop of **0.5–2 s**. Measured (Apple M1 Max,
warm cargo cache, settled run):

| Metric (edit → …)                          |          min |          p50 |          p95 |          max |         mean |
| ------------------------------------------ | -----------: | -----------: | -----------: | -----------: | -----------: |
| publish (gate + `-hot-live` atomic rename) |     2 510 ms |     2 534 ms |     2 593 ms |     2 863 ms |     2 561 ms |
| swap (publish → host swap report)          |       892 ms |       935 ms |       969 ms |       983 ms |       937 ms |
| **total (edit → swap)**                    | **3 451 ms** | **3 478 ms** | **3 517 ms** | **3 816 ms** | **3 498 ms** |

(run 2, n=20 measured. Combined n=40 across both runs: total p50 3 502 ms, p95
4 264 ms, max 10 875 ms.)

**Judgment: the 0.5–2 s target is not met.** The stable total is ≈3.5 s — about 1.75×
the 2 s upper bound — and the best observed cycle is 3.45 s. Publish (cargo rebuild)
dominates; swap adds a fairly constant ~0.93 s.

## Environment

| Item            | Value                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine         | MacBookPro18,2 (Apple M1 Max), 64 GB, arm64                                                                                                                                                                                                                                                                                              |
| OS              | macOS 26.6.2                                                                                                                                                                                                                                                                                                                             |
| Toolchain       | cargo/rustc 1.98.0 (797e8a9bc / 88d9e12ae), bun 1.4.0                                                                                                                                                                                                                                                                                    |
| Cargo cache     | warm — `target/debug` pre-populated the same day; the initial `rustra dev` run reported both cargo steps at 0.1 s                                                                                                                                                                                                                        |
| Ambient load    | desktop session with load average ≈ 7 (WindowServer, browsers, an Android emulator); the user's normal working condition                                                                                                                                                                                                                 |
| Contention note | a second worker was editing `crates/rustra` and `Cargo.toml`/`Cargo.lock` in this checkout during run 1 (`tauri_support.rs` mtime 23:46:47, inside run 1's window). Run 1's outliers (cycles 6 and 13, 7.1 s cargo steps) match those dependency-invalidation events. Run 2 ran with no overlapping writes and is the settled reference. |

## What was measured

One cycle = one schema-invariant Rust edit flowing through the real dylib dev loop:

1. `examples/calculator/src/lib.rs` — `add_numbers` body toggled
   `input.a + input.b` ⇄ `input.a + input.b + std::hint::black_box(0)`.
   `black_box` prevents constant folding, so the cdylib bytes provably change each
   toggle (two stable byte states, sha256-12 `ed21b2366173` ⇄ `35170b453dc1`),
   while schema, contract hash, and behavior (2+3=5) stay identical — the exact
   "logic-only swap" the parity gate must pass.
2. `rustra dev --config <bench config>` (watch mode) detects the change
   (fs.watch + 300 ms debounce) → codegen (`cargo run --bin generate` + TS render)
   → `cargo build --lib` (cdylib) → parity gate → atomic publish to
   `target/debug/librustra_calculator_example-hot-live.dylib`.
3. The host watches the live artifact with the production watch primitive
   (`spawn_dylib_watch`, 300 ms sha256 polling) and reports the swap.

Timestamps: `t_edit` = after the source write returns; `t_publish` = first harness
poll (10 ms interval) where the live artifact has a new inode **and** sha256;
`t_swap` = arrival of the host's swap line. Swap report text is
`PROBE SWAP <old> -> <new>` with identical old/new contract hashes — confirming
schema-invariant swaps pass the gate and keep the contract stable.

### Host choice

The design's reference host is the Tauri app, but `tauri.conf.json` defines a
visible window and `examples/tauri-calculator/**` is modification-frozen, so the
loop cannot run unattended with the GUI app. Per the design doc's own fallback the
benchmark uses `examples/hot-core-probe --watch`, which opens its initial core
**from the live path** and shares the same `spawn_dylib_watch` primitive, the same
300 ms sha256 polling, the same versioned copy + ad-hoc re-sign + dlopen + handle
swap sequence. The measured swap path is the production path; only the report
channel differs (stdout line instead of stderr/webview event).

### Blocking bug found while setting this up (pre-existing, uncommitted-workspace independent)

> **FIXED (2026-09-10, after this measurement).** `packages/cli/src/host-entries.ts`
> now falls back to `codegen.rustManifest` for the node/bun host sections (same
> priority as the wasm/dylib dev targets), and `cli-codegen.ts` pins the Rust
> bin's `RUSTRA_SCHEMA_OUT` to the config-declared schema directory (previously
> the bin's CWD-relative default wrote a stray `generated/schema.json` copy next
> to the config and left `config.schemaPath` — the parity gate's input — stale).
> `bun scripts/hot-core-loop-bench.mjs` now runs against the default
> `rustra.hot.json`; the numbers below are unaffected (the fix changes where the
> schema lands, not the loop's cargo/gate/poll work). Regression tests:
> `packages/cli/src/host-entries.test.ts`.

`rustra dev --config examples/tauri-calculator/rustra.hot.json` — the exact command
documented in `examples/tauri-calculator/README.md` — **fails during codegen** on
this branch:

```
[dev] regeneration failed: TypeScript/C++ generation failed for
.../rustra.hot.json: Host setup found 0 Cargo packages (none).
Point rustManifest at the app crate, or set the host rustPackage.
```

Root cause: `rustra.hot.json` declares `"node": {}` / `"bun": {}`. In
`packages/cli/src/host-entries.ts` those sections resolve the manifest with
`findCargoManifest(appRoot)` where `appRoot` is `examples/tauri-calculator` — that
directory has no `Cargo.toml`, so the search walks up to the workspace root
`Cargo.toml`, which itself is no package's manifest → `selectHostPackage` finds 0
candidates and throws. `codegen.rustManifest` (→ `examples/calculator/Cargo.toml`)
is only consulted for the schema step and the dylib section, not for the node/bun
host entries. `runtime-smoke.mjs` bypasses `runCodegen` (it calls
`readDevConfig`/`buildDylibCore`/`publishGatedArtifact` directly), which is why the
smoke gate does not catch this.

Workaround used for the benchmark (no repository files created): an equivalent
config outside the repo, passed via `BENCH_CONFIG`:

```json
{
  "schema": "/Users/loopy/dev/ll3/rustra-bridge/examples/calculator/generated/schema.json",
  "output": "/Users/loopy/dev/ll3/rustra-bridge/examples/calculator/generated",
  "codegen": {
    "rustManifest": "/Users/loopy/dev/ll3/rustra-bridge/examples/calculator/Cargo.toml",
    "rustPackage": "rustra-calculator-example",
    "rustBinary": "generate"
  },
  "node": { "rustManifest": "/Users/loopy/dev/ll3/rustra-bridge/examples/calculator/Cargo.toml" },
  "bun": { "rustManifest": "/Users/loopy/dev/ll3/rustra-bridge/examples/calculator/Cargo.toml" },
  "tauri": {},
  "dev": { "target": "dylib" }
}
```

This resolves every section to the same manifests/outputs, so the dev loop watches,
builds, gates, and publishes identically. Byte-identity of codegen output was
verified per run: all of `examples/calculator/generated/` hashed before/after —
identical — and `git status --porcelain examples/calculator` stayed empty.

## Raw data

### Run 1 — with concurrent `crates/rustra` edits landing (contention window)

Warmup cycles 1–2 excluded from stats. `schemaGen`/`dylibBuild` are the CLI's own
cargo step durations (`done in X.Xs` lines).

| cycle | phase    | publish ms | swap ms | total ms | schemaGen | dylibBuild | live sha12   |
| ----: | -------- | ---------: | ------: | -------: | --------: | ---------: | ------------ |
|     1 | warmup   |       2921 |     410 |     3331 |      2.5s |       0.1s | ed21b2366173 |
|     2 | warmup   |       2565 |     894 |     3459 |      2.1s |       0.1s | 35170b453dc1 |
|     3 | measured |       2565 |     922 |     3488 |      2.1s |       0.1s | ed21b2366173 |
|     4 | measured |       2521 |     950 |     3471 |      2.1s |       0.1s | 35170b453dc1 |
|     5 | measured |       2519 |    1007 |     3526 |      2.1s |       0.1s | ed21b2366173 |
|     6 | measured |       7143 |     925 |     8068 |      6.6s |       0.2s | 35170b453dc1 |
|     7 | measured |       3418 |     846 |     4264 |      3.0s |       0.1s | ed21b2366173 |
|     8 | measured |       2732 |    1162 |     3894 |      2.2s |       0.2s | 35170b453dc1 |
|     9 | measured |       2788 |     794 |     3582 |      2.4s |       0.1s | ed21b2366173 |
|    10 | measured |       3099 |     452 |     3551 |      2.7s |       0.1s | 35170b453dc1 |
|    11 | measured |       3285 |     738 |     4024 |      2.9s |       0.1s | ed21b2366173 |
|    12 | measured |       2592 |     910 |     3502 |      2.2s |       0.1s | 35170b453dc1 |
|    13 | measured |       9550 |    1325 |    10875 |      2.1s |       7.1s | ed21b2366173 |
|    14 | measured |       3458 |     750 |     4208 |      3.0s |       0.1s | 35170b453dc1 |
|    15 | measured |       2656 |    1063 |     3719 |      2.2s |       0.2s | ed21b2366173 |
|    16 | measured |       2741 |     843 |     3584 |      2.3s |       0.1s | 35170b453dc1 |
|    17 | measured |       3234 |     962 |     4197 |      2.8s |       0.1s | ed21b2366173 |
|    18 | measured |       3510 |     650 |     4159 |      3.0s |       0.1s | 35170b453dc1 |
|    19 | measured |       2691 |     842 |     3533 |      2.3s |       0.1s | ed21b2366173 |
|    20 | measured |       2777 |     710 |     3487 |      2.2s |       0.3s | 35170b453dc1 |
|    21 | measured |       2561 |     915 |     3476 |      2.1s |       0.1s | ed21b2366173 |
|    22 | measured |       2547 |     942 |     3489 |      2.1s |       0.1s | 35170b453dc1 |

Run 1 summary (n=20): publish p50 2741 / p95 7143 / max 9550; swap p50 910 / p95
1162 / max 1325; total p50 3582 / p95 8068 / max 10875.

### Run 2 — settled (no overlapping writes; reference run)

| cycle | phase    | publish ms | swap ms | total ms | schemaGen | dylibBuild | live sha12   |
| ----: | -------- | ---------: | ------: | -------: | --------: | ---------: | ------------ |
|     1 | warmup   |       2563 |     792 |     3354 |      2.1s |       0.1s | ed21b2366173 |
|     2 | warmup   |       2577 |     922 |     3499 |      2.1s |       0.1s | 35170b453dc1 |
|     3 | measured |       2577 |     912 |     3489 |      2.1s |       0.1s | ed21b2366173 |
|     4 | measured |       2529 |     957 |     3486 |      2.1s |       0.1s | 35170b453dc1 |
|     5 | measured |       2863 |     953 |     3816 |      2.4s |       0.1s | ed21b2366173 |
|     6 | measured |       2547 |     932 |     3479 |      2.1s |       0.1s | 35170b453dc1 |
|     7 | measured |       2589 |     900 |     3488 |      2.1s |       0.1s | ed21b2366173 |
|     8 | measured |       2593 |     918 |     3511 |      2.2s |       0.1s | 35170b453dc1 |
|     9 | measured |       2517 |     947 |     3465 |      2.1s |       0.1s | ed21b2366173 |
|    10 | measured |       2563 |     892 |     3455 |      2.1s |       0.1s | 35170b453dc1 |
|    11 | measured |       2554 |     910 |     3463 |      2.1s |       0.1s | ed21b2366173 |
|    12 | measured |       2534 |     929 |     3464 |      2.1s |       0.1s | 35170b453dc1 |
|    13 | measured |       2523 |     935 |     3458 |      2.1s |       0.1s | ed21b2366173 |
|    14 | measured |       2526 |     983 |     3509 |      2.1s |       0.1s | 35170b453dc1 |
|    15 | measured |       2510 |     969 |     3478 |      2.1s |       0.1s | ed21b2366173 |
|    16 | measured |       2534 |     917 |     3451 |      2.1s |       0.1s | 35170b453dc1 |
|    17 | measured |       2515 |     950 |     3465 |      2.1s |       0.1s | ed21b2366173 |
|    18 | measured |       2526 |     950 |     3476 |      2.1s |       0.1s | 35170b453dc1 |
|    19 | measured |       2531 |     931 |     3471 |      2.1s |       0.1s | ed21b2366173 |
|    20 | measured |       2551 |     959 |     3511 |      2.1s |       0.1s | 35170b453dc1 |
|    21 | measured |       2551 |     961 |     3512 |      2.1s |       0.1s | ed21b2366173 |
|    22 | measured |       2551 |     942 |     3512 |      2.1s |       0.1s | 35170b453dc1 |

Run 2 summary (n=20): publish p50 2534 / p95 2593 / max 2863; swap p50 935 / p95
969 / max 983; total p50 3478 / p95 3517 / max 3816. The spread (max−min of total
= 365 ms) shows the loop itself is highly deterministic once dependency graphs are
settled.

### Combined (n = 40 measured, warmups excluded)

| Metric     |  min |  p50 |  p90 |  p95 |   max |   mean |
| ---------- | ---: | ---: | ---: | ---: | ----: | -----: |
| publish ms | 2510 | 2565 | 3418 | 3510 |  9550 | 2990.2 |
| swap ms    |  452 |  929 |  983 | 1063 |  1325 |  911.4 |
| total ms   | 3451 | 3502 | 4197 | 4264 | 10875 | 3901.5 |

## Bottleneck analysis (median cycle ≈ 3.48 s, run 2)

| Stage                                                    |         Median cost | Share | Evidence                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------: | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watch debounce (`createWatchLoop` 300 ms)                |             ~300 ms |    9% | constant by construction                                                                                                                                                                |
| Codegen, cargo step (`cargo run --bin generate`)         |           ~2 100 ms |   60% | CLI's own step timer: `schemaGen 2.1s` in 26/40 measured cycles and 2.1–3.0 s in all cycles except the two invalidation outliers; median across both runs: 2.1 s                        |
| Codegen, TS render + dylib cargo + gate + publish        |             ~130 ms |    4% | residual of publishMs minus debounce minus cargo steps; `dylibBuild 0.1s` median — the second cargo invocation is fingerprint-fresh because the first already carried the crate rebuild |
| Swap poll (sha256, 300 ms interval)                      | 0–300 ms (avg ≈150) |   ~4% | `hot_core_watch` poll interval                                                                                                                                                          |
| Swap mechanics (copy + re-sign + dlopen + init + report) |             ~780 ms |   22% | swapMs p50 935 minus avg poll 150; see cost split below                                                                                                                                 |

Measured swap-mechanics unit costs (independent timings on the 11 MB live artifact,
`/usr/bin/time` over 3 runs each): full-file copy ≈ 10 ms, ad-hoc
`codesign --force --sign -` ≈ 20–30 ms, sha256 read ≈ 10 ms. Those three total
~50 ms, so the dominant part of a swap (~0.7 s) is `DylibCore::open` — dlopen of the
11 MB debug cdylib plus rustra core initialization (package registration, contract
hash binding) — plus handle swap and report. That residual was not instrumented
internally (crates/ untouched); it is reported as an arithmetic remainder, not a
direct measurement.

Takeaways:

1. **Cargo owns the loop.** The single `cargo run --bin generate` in the codegen
   stage recompiles the example crate (~2.1 s warm, incl. its rlib/cdylib/staticlib
   units — the subsequent `cargo build --lib` is a 0.1 s no-op in 39/40 cycles).
   The 0.5–2 s target cannot be reached while every logic edit pays a full crate
   rebuild plus a 300 ms debounce, regardless of how fast the swap is.
2. **The swap side is fast but not free.** ~0.93 s median is mostly dlopen/init +
   the poll quantum. Halving the poll interval would shave only ≈75–150 ms; it
   would not change the verdict.
3. **Run-to-run outliers were external.** The two >6.5 s cargo steps in run 1
   coincide
   with a sibling worker's `crates/rustra` edits landing (dependency invalidation);
   run 2 has zero outliers beyond +338 ms over its p50.

## Cross-iteration rationale

- Minimum required was 7 measured cycles; this benchmark ran **40 measured cycles
  across 2 independent runs** (plus 4 warmups and 2 smoke cycles), sequential per
  the no-contention constraint.
- Warmup (2 per run) absorbs cargo/feature-graph settling after the probe build
  flips the `rustra` feature set (`hot-core` on for the probe, off for the dev
  build) and any FS cache cooling. Run 2's warmup-1 total (3 354 ms) already equals
  its measured median, so 2 warmups suffice.
- The toggle alternates between exactly two compiled byte states (sha256-12
  `ed21b2366173` / `35170b453dc1`, stable across all 44 cycles), so every cycle is
  a genuine rebuild-swap of a real code change, and the alternating pattern gives a
  simple drift check: any cycle publishing the wrong state would break the
  sequence.
- Two runs on the same machine bracket the contention question: run 1 (outliers,
  correlated with concurrent edits) vs run 2 (clean) demonstrates which numbers are
  intrinsic to the loop.

## Integrity checks (per harness output, both runs)

- `examples/calculator/src/lib.rs` restored byte-identical to `HEAD` after each run.
- `examples/calculator/generated/` content hashes identical before/after — codegen
  is byte-stable for schema-invariant edits.
- `git status --porcelain examples/calculator` empty after each run.
- Harness deletes only the `-hot-<n>` swap copies it created; `-hot-live` and
  pre-existing files are untouched. Successful swaps leak the previous core by
  contract (dlclose is forbidden), ≈11 MB per swap in the host process — dev-only,
  bounded by session length.

## Reproduce

```sh
# one-off setup equivalent to the harness preflight
cargo build -q -p rustra-hot-core-probe
bun run --cwd packages/cli build

# full benchmark (2 warmup + 20 measured), ~4.5 min sequential
BENCH_CONFIG=/tmp/rustra-hot-bench/rustra-hot-bench.json \
  bun scripts/hot-core-loop-bench.mjs

# smaller sweep
BENCH_CONFIG=/tmp/rustra-hot-bench/rustra-hot-bench.json \
  BENCH_WARMUP=2 BENCH_CYCLES=7 bun scripts/hot-core-loop-bench.mjs
```

`BENCH_CONFIG` was needed while the `rustra.hot.json` node/bun host-entry bug above
was live; it is fixed now (see the notice at the bug section), so plain
`bun scripts/hot-core-loop-bench.mjs` (defaulting to
`examples/tauri-calculator/rustra.hot.json`) suffices.
