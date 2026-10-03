# On-Device A/B Measurement Runbook — E1 Owned Handoff · A2 Emit Switch · rn-experiment Buffer

Executable runbook for the three pending adoption-grade device measurements. It follows the
name-reuse adoption precedent ([protocol](dev/research/2026-09-16-nitro-call-profile.md),
[receipt](benchmark-receipts/2026-09-18-nitro-name-reuse-ab.json), contract
`rustra-name-reuse-ab/v1` format) and the plan fixed in
[performance-evaluation.md §7.3/§7.6](performance-evaluation.md).

- **Adoption judgments come only from running this runbook.** Simulator numbers
  ([sim-hotswap](benchmark-receipts/2026-09-24-sim-hotswap.md),
  [sim-e1](benchmark-receipts/2026-09-24-sim-e1-hermes.md), summarized in
  [performance-evaluation.md §8](performance-evaluation.md)) are reference-only: they prove
  paths work end-to-end, they do not decide adoption.
- Every `bun` command must run as `env -u RUSTRA_BUN_LIBRARY …` (loop-daemon dylib guard —
  same rule as all receipts on 2026-09-24).

## 0. Common protocol (all three items)

Fixed rules carried over from the name-reuse precedent — do not renegotiate them per item:

1. **Freeze the source first.** Formatting-normalized, new source committed (or stashed to a
   fixed tree state) before any build. The candidate arm and legacy arm differ only in the
   item's own diff (§1.1, §2.2, §3.2).
2. **Instrumentation-free Release builds.** No profiler attached, no GC forcing, no slow-sample
   exclusion. A failed or interrupted run is either kept whole or rerun from install.
3. **Independent launches, install swapped per run.** Exactly one arm is installed at a time;
   the dedicated app id `com.rustra.nitroparity` is enforced by
   `examples/react-native-calculator/scripts/parity-app-policy.ts` (`requireDedicatedApp`).
4. **Per-run receipt validation.** Every launch must pass the full v2 matrix receipt
   validation (90 cases = 30 ids × 3 lanes, 31 rounds per case) against the host manifest, and
   the binary SHA-256 is re-checked after the run. `run-nitro-parity-once.ts` does both and
   aborts the protocol otherwise.
5. **Statistics.** Paired per-launch log-ratio, nominal t(4) 95% intervals, no multiplicity
   correction; per-lane and overall geomeans of candidate/legacy ratios. A watch case whose CI
   contains 1 is reported as not significant, never as a win.
6. **Receipt artifact.** Each executed item writes
   `docs/benchmark-receipts/<date>-<item>-ab.json` in the `rustra-name-reuse-ab/v1` shape:
   `contract`, `status` (adopted/rejected), `date`, `sourceCommit`, `candidateBaseline`,
   `decision`, `environment` (device, runtime, udid, jsEngine), `methodology` (protocol, runs,
   launchesPerArm, suite, validation, statistics), `arms` (per-arm description, runs,
   `binarySha256`, `bundleSha256`, `fingerprint`, launches), analysis. Keep raw logs under
   `target/<item>-ab/`.

### 0.1 Collector/aggregator reuse (already in-tree)

```bash
cd examples/react-native-calculator

# one launch of the installed arm: validates receipt vs host manifest, re-checks binary SHA,
# writes /tmp/parity-ab/run-<N>/receipt.json (wrapper: label, binarySha256, bundleSha256,
# fingerprint, launch pid, receipt)
env -u RUSTRA_BUN_LIBRARY bun scripts/run-nitro-parity-once.ts \
  --device $UDID --output /tmp/parity-ab/run-1 --label C   # or --label L

# after all 10 runs: per-case ratios, per-lane/overall geomeans, paired t(4) counts
env -u RUSTRA_BUN_LIBRARY bun scripts/aggregate-parity-ab.ts
# → /tmp/parity-ab/aggregate-raw.json, /tmp/parity-ab/paired-cases.json
```

`aggregate-parity-ab.ts` hardcodes the implemented precedent values: candidate runs
`C_RUNS = [1,4,5,8,10]`, legacy runs `L_RUNS = [2,3,6,7,9]`, pairs
`(C1,L2)(C4,L3)(C5,L6)(C8,L7)(C10,L9)`. **One adaptation is required per item:** its
`manifestFor(arm)` reproduces each arm's build fingerprint by patching
`modules/rustra-jsi/generated/rustra-generated-codecs.hpp` (the name-reuse define toggle).
`aggregate()` validates receipts against the fingerprint of the _live_ tree, so for a new item
the toggle must be replaced by that item's arm difference (E1: bridge/core E1 diff, §1.1;
A2: generated `commands.ts` variant, §2.2) — everything else stays as-is.

### 0.2 Devices

| Lane                         | Device                                                                                                 | Note                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS runs                     | iPhone 17 Simulator, iOS 26.2 (UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC` in the 2026-09-24 receipts) | the 9/18 name-reuse adoption ran its iOS matrix on this simulator; reuse it for comparability                                                         |
| iOS runs (optional physical) | physical iPhone, `aarch64-apple-ios`                                                                   | build with `RUSTRA_IOS_TARGET=aarch64-apple-ios`; install/launch/pull via `xcrun devicectl` — not yet exercised in-repo, treat as unverified plumbing |
| Android runs                 | physical device                                                                                        | v2 precedent; fixed-candidate 5 runs, **never** described as a causal A/B against a preserved older cohort                                            |

## 1. E1 — large-response owned handoff (probe-cache 2-FFI round trip removed)

### 1.1 Premises (device/build)

- Host pre-gates already green (performance-evaluation.md §7.2): Rust workspace, TS release
  gates, C++ codec suite, Hermes assertion suite (1,383 assertions), ASan, `tree_route`
  alternating host A/B. Do not re-litigate correctness on device — the 90-case validation per
  run is the on-device correctness gate.
- **No runtime toggle exists** (sim-e1 receipt §3-1): `invoke_frame_owned` is bound
  unconditionally when the symbol exists. Arms are therefore two per-install builds:
  - **candidate (C)** = current main. Pre-check once, per arm binary:
    `nm -gU -arch arm64 <app binary> | grep rustra_ffi_invoke_frame_owned` must list the
    symbol (T) — E1 branch active, probe fallback dead code.
  - **legacy (L)** = E1-reverted build: the E1 diff removed from
    `crates/rustra/src/ffi_typed_buffer.rs` **and** `packages/react-native/native/cpp/RustraJSIBridge.{hpp,cpp}`
    together, built as one tree. The "new shell + old static core" link combination is
    unsupported (Apple linker rejects unresolved weak refs — performance-evaluation.md §7.5
    risk 1); the probe path arms must come from a coherent pre-E1 source state.
- Build: `sh modules/rustra-jsi/ios/build-rust-ios.sh` (fat release core) → `xcodebuild
-configuration Release -sdk iphonesimulator` exactly as in the sim-e1 receipt's
  reproduction runbook, with `env -u EXPO_PUBLIC_RUSTRA_DEMO`, then
  `xcrun simctl install $UDID <app>`. Record `binarySha256`/`bundleSha256` per arm (the
  collector records them into every run wrapper).

### 1.2 Sample design and commands

- **iOS: 5 pairs, install swapped every run, 10 runs total.** Run order
  `C L L C C L L C L C` — candidate occupies runs {1,4,5,8,10} (matches §0.1 aggregator
  constants and the 9/18 executed protocol "AB BA AB BA AB"). Each run = full v2 90-case
  matrix through `run-nitro-parity-once.ts` (§0.1).
- **Interpretation lanes:** split by response size — large-response lanes
  (`balanced8191/echo`, `balanced8191/setup`, `balanced8191/update`, `wide1025/echo` in
  sync-public/async-public) are the target lanes; small-response lanes (`add`, `string`,
  `pair`, `*/indexed`, `*/resident-dfs`) are the no-regression lanes.
- **Android: fixed candidate, original v2 5 runs** via
  `env -u RUSTRA_BUN_LIBRARY bun scripts/run-nitro-parity-android.ts --device <serial>
--apk <candidate.apk> --manifest <manifest.json> --output <dir>` (the tool never installs —
  `adb install` the arm APK first; export the manifest JSON from
  `createExperimentManifest(fingerprint)` of `scripts/parity-manifest.ts`). Differences vs the
  preserved pre-E1 cohort are reported as cohort deltas, not causal A/B.

### 1.3 Artifact paths

- Raw: `/tmp/parity-ab/run-{1..10}/receipt.json`, `/tmp/parity-ab/aggregate-raw.json`,
  `/tmp/parity-ab/paired-cases.json`; build/install logs under `target/e1-ab/`.
- Receipt: `docs/benchmark-receipts/<date>-e1-owned-handoff-ab.json` (§0 shape), decision
  recorded in `performance-evaluation.md` §8 follow-up.

### 1.4 Adoption / rejection criteria

- **Adopt** iff: large-response lanes' geomean candidate/legacy ratio < 1 with the paired
  t(4) interval excluding 1 (host estimate ~1–2% — small absolute widths are expected), AND
  small-response lanes show no significant regression (no lane geomean > 1 with CI excluding
  1), AND all 10 runs passed the 90-case validation (correctness, handler-exactly-once,
  free-pair kept).
- **Reject** if any small-response regression is significant, or large-lane improvement is
  within noise. Rejection keeps main as-is (probe fallback path is retained in code by
  design) and records the receipt with `status: "rejected"` — the postcard-candidate
  precedent (2026-09-16) is the format example for rejected outcomes.

### 1.5 Rollback

E1 spans Rust core + C++ bridge + snapshot/CHANGELOG. Rollback = single revert of the E1
commits (or `git checkout` of the pre-E1 state for the two source groups above), rebuild, then
re-run: `cargo test -p rustra`, `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`,
`env -u RUSTRA_BUN_LIBRARY bun run test:all`. The legacy arm build of §1.1 doubles as the
rollback verification build.

## 2. A2 — 1-field command emit switched to `createGeneratedFields1`

### 2.1 Premises

- Pure JS + codegen change (no ABI, no native, no capability marker). Host microbench evidence
  exists (warm 20.81%, reproduced 4×, call-count invariant 660,004 = 660,004 —
  [decision doc](research/2026-09-24-emit-switch-decision.md)).
- **Leading gates before the device matrix** (performance-evaluation.md §7.5 risk 2 — these
  close the not-yet-re-confirmed items):
  1. Hermes assertion suite re-run on the switched tree:
     `sh examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh` —
     0 failures required.
  2. Call-count invariance re-assertion:
     `env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs` — native route calls
     must equal JS calls, 0 name fallbacks.
  3. `env -u RUSTRA_BUN_LIBRARY bun run test:types` + `env -u RUSTRA_BUN_LIBRARY bun run test:codegen-fresh:check`.

### 2.2 Arms and toggling

Both arms share the **same native binary**; only the JS bundle differs:

- **candidate (C)** = current generated `commands.ts`
  (`createGeneratedFields1(id, 'name', "key", 'fn')` factory emit).
- **legacy (L)** = same tree with the emit switched back — regenerate
  `examples/react-native-calculator/generated/commands.ts` with the pre-switch CLI (parent of
  the emit commit), or `git checkout <emit-commit>^ -- examples/react-native-calculator/generated`
  and re-bundle. Record per-arm `bundleSha256`; `binarySha256` is expected identical — if it
  is not, the arms are contaminated, stop and rebuild.

### 2.3 Sample design, lanes, criteria, rollback

- **iOS: same 5-pair install-swap protocol as §1.2** (10 runs, full 90-case validation,
  aggregator reuse with the §0.1 `manifestFor` toggle pointed at the generated-`commands.ts`
  variant). **Android: fixed candidate, v2 5 runs** (§1.2).
- **Interpretation lanes:** the indexed cases (4 tree shapes × sync-public + async-public = 8
  cases) and the `string` cases (sync + async = 2 cases) — §7.6 "indexed 8건·string 2건".
  These exercise 1-field generated commands on the device. All other lanes are no-regression
  lanes.
- **Adopt** iff: indexed/string lanes geomean ratio < 1 with paired t(4) CI excluding 1 (the
  host effect is ~4 ns/call — treat device effect as confirmed-sign/confirmed-noise, not
  magnitude), no significant regression anywhere, leading gates green.
- **Rollback:** single commit `git revert` of the emit switch + regenerate all six examples'
  `generated/` with the same CLI; verify with `test:codegen-fresh:check`
  ([decision doc rollback strategy](research/2026-09-24-emit-switch-decision.md)).

## 3. rn-experiment — buffer-path superiority re-measurement (real workloads)

### 3.1 Premises

- `examples/rn-experiment` cross-compiles for `aarch64-apple-ios-sim` Release with 0
  mismatches against its generated module scripts/podspec
  ([build evidence](research/2026-09-24-rn-experiment-ios.md)). Physical iOS uses
  `RUSTRA_IOS_TARGET=aarch64-apple-ios`; Android uses
  `modules/rustra-bridge/android/build-rust-android.sh`.
- This item is **not an install-swap A/B**: the contrast is between lanes inside one app —
  `gzipCompress`/`gzipDecompress` (single-`data`-field bytes schema → Tier buffer fast path,
  `rustra_ffi_has_buffer` advertised) vs `uuidV7` (string schema → JSON path control).
- Payloads: deterministic LCG-generated repeat+noise buffers, 32–64 KiB (same alphabet as the
  native/adapter tests), plus 1 MiB for the order-effect watch.

### 3.2 Harness (to be added at execution time — schema fixed here)

The RN app-side collector following `BenchmarkApp`'s receipt pattern does not exist yet; when
executing, add it to the rn-experiment app and fix the receipt contract to:

```json
{ "contract": "rustra-rn-experiment-buffer/v1", "launch": 1, "platform": "ios|android",
  "order": ["gzipCompress","uuidV7"] | ["uuidV7","gzipCompress"],
  "payloads": { "bytesKiB": 32, "sha256": "…" },
  "samples": { "gzipCompress": {"p50ns": 0, "p95ns": 0, "roundTripOk": true},
               "gzipDecompress": {"p50ns": 0, "equalityOk": true},
               "uuidV7": {"p50ns": 0, "formatOk": true} } }
```

One receipt per launch, written to app `Documents/` and pulled with
`xcrun simctl get_app_container … data` + copy (device: `devicectl device copy from`).

### 3.3 Sample design, criteria, rollback

- **iOS and Android: 5 independent launches each.** Alternate the emission order across
  launches (`gzip-first` / `uuid-first`) to observe the 64 KiB/1 MiB order sensitivity known
  from the Android buffer diagnostic (2026-09-16) — report order effects, never average them
  away.
- **Adopt (i.e., confirm the documented buffer advantage on real workloads)** iff: gzip
  round-trip p50 beats the `uuidV7` JSON-path control in ≥ 4/5 launches per platform with
  paired log-ratio t(4) CI excluding 1, and correctness gates hold in every launch (gzip
  magic, decompress equality, uuid format).
- **If not reproduced:** rn-experiment is an example crate with no product surface — no
  rollback. Record the receipt (`status: "rejected"`), and annotate
  `docs/rn-rust-native-bridge-comparison.ko.md` / performance docs that the buffer fast-path
  advantage claim is scoped to conversion-only workloads (`benchEchoBytes`), not
  compute-inclusive ones.
- Receipt: `docs/benchmark-receipts/<date>-rn-experiment-buffer-ab.json`.

## 4. Execution order and reporting

1. A2 leading gates (§2.1) — cheap, closes §7.5 risk 2 first.
2. E1 matrix (§1) — largest expected effect, largest build cost (two full arm builds).
3. A2 matrix (§2.3) — reuses the same installed-app plumbing as E1.
4. rn-experiment harness (§3) — independent example app, can run in parallel with 2–3 on a
   second machine but not interleaved on one simulator.
5. Each item appends its verdict to `performance-evaluation.md` §8 and files its receipt per
   §0. The runbook itself is versioned; protocol deviations (device substitution, run loss)
   must be recorded in the receipt's `methodology` block, not silently absorbed.
