# On-Device A/B Measurement Runbook — E1 Owned Handoff · A2 Emit Switch · rn-experiment Buffer

Runbook for three pending device measurements. E1/A2 use the matrix protocol; §3 uses its own same-operation collector. It follows the
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
3. **E1/A2 independent launches, install swapped per run.** Exactly one arm is installed at a time;
   the dedicated app id `com.rustra.nitroparity` is enforced by
   `examples/react-native-calculator/scripts/parity-app-policy.ts` (`requireDedicatedApp`).
4. **E1/A2 per-run receipt validation.** Every matrix launch must pass the full v2 matrix receipt
   validation (90 cases = 30 ids × 3 lanes, 31 rounds per case) against the host manifest, and
   the binary SHA-256 is re-checked after the run. `run-nitro-parity-once.ts` does both and
   aborts the protocol otherwise.
5. **Statistics.** Paired per-launch log-ratio, nominal t(4) 95% intervals, no multiplicity
   correction; per-lane and overall geomeans of candidate/legacy ratios. A watch case whose CI
   contains 1 is reported as not significant, never as a win.
6. **E1/A2 receipt artifact.** Each executed matrix item writes
   `docs/benchmark-receipts/<date>-<item>-ab.json` in the `rustra-name-reuse-ab/v1` shape:
   `contract`, `status` (adopted/rejected), `date`, `sourceCommit`, `candidateBaseline`,
   `decision`, `environment` (device, runtime, udid, jsEngine), `methodology` (protocol, runs,
   launchesPerArm, suite, validation, statistics), `arms` (per-arm description, runs,
   `binarySha256`, `bundleSha256`, `fingerprint`, launches), analysis. Keep raw logs under
   `target/<item>-ab/`.
7. **Host criterion benches carry provenance.** Run
   `env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-environment.mjs target/criterion` before
   every measuring session — from the second call onward the previous record is paired as the
   baseline-era record. The regression gate
   (`check-criterion-regression.mjs`) treats a comparison whose baseline-era record is
   missing or incomplete as unmeasurable (exit 2 — verdict withheld, baseline not adopted).
   CPU model, architecture, CPU counts, memory GiB class, kernel major/minor, OS image,
   toolchain and build-flag mismatches also stop comparison before timing verdicts.
   Runner-image/kernel patch and small memory differences within the same GiB class are
   advisory. Preserve the baseline and rerun both revisions with `comparison_ref` on one
   runner. The local policy fix has not yet restored the remote Benchmark verdict.

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
| iOS reference runs           | iPhone 17 Simulator, iOS 26.2 (UDID `99B087B5-DEF6-4CF1-9177-81A5DE564CFC` in the 2026-09-24 receipts) | historical simulator comparison only; this does not establish a physical-device effect                                                                |
| iOS adoption runs (physical) | physical iPhone, `aarch64-apple-ios`                                                                   | build with `RUSTRA_IOS_TARGET=aarch64-apple-ios`; install/launch/pull via `xcrun devicectl` — not yet exercised in-repo, treat as unverified plumbing |
| Android runs                 | physical device                                                                                        | v2 precedent; fixed-candidate 5 runs, **never** described as a causal A/B against a preserved older cohort                                            |

### 0.3 Host A/B receipt producers (not CI gates)

The 2026-10-13 host perf receipts were produced by three one-shot harnesses plus two host
microbench apps. They are measurement producers, not examples — keep them runnable so the
committed receipts stay reproducible-as-documented. Each receipt records its exact
`command` invocation and the source/artifact hashes, so rerunning after `bun run build:cli`
reproduces the comparison shape against a preserved baseline tree:

- `env -u RUSTRA_BUN_LIBRARY bun scripts/benchmark-bun-owned.mjs <bun-ffi.ts> <dylib> <receipt.json> <label>`
  — Bun FFI owned-response A/B
  ([receipt](benchmark-receipts/2026-10-13-bun-owned-ab.json),
  [journey](dev/research/2026-10-13-bun-owned-response.md)).
- `node scripts/node-framing-bench.mjs <built-module> <receipt.json>` — binary frame
  fragmentation copy-count A/B
  ([receipts](benchmark-receipts/2026-10-13-node-framing-ab.json), incl. the superseded
  `-initial` and `-fastpath` candidates preserved as evidence).
- `node scripts/node-native-echo-bench.mjs <adapter-entry> <frame-registry> <runtime-binary> <receipt.json>`
  — fragmented-frame end-to-end echo against the same runtime binary.
- `env -u RUSTRA_BUN_LIBRARY bun examples/calculator/apps/bun-ffi-bench.ts` and
  `env -u RUSTRA_BUN_LIBRARY bun examples/calculator/apps/scriptc-bench.ts` — warm host
  dispatch microbenches for the Bun FFI and scriptc surfaces (3-shape arm reporting; see the
  2026-10-13 research logs for arm construction).

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
- Build: `bash modules/rustra-jsi/ios/build-rust-ios.sh` (fat release core) → `xcodebuild
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
  [decision doc](dev/research/2026-09-24-emit-switch-decision.md)).
- **Leading gates before a new device matrix.** Historical re-verification on `4578c851`
  passed Hermes 1,412/0 and call counts 660,004=660,004 with no fallback
  ([2026-10-10 receipt](benchmark-receipts/2026-10-10-host-gates-reverify.md)).
  [2026-10-13 native ASan evidence](verification/evidence/2026-10-13-native-asan.json)
  adds 1,412/0 plus 100 teardown/reinstall cycles on a simulator. It instruments the C++
  binder/generated codecs/JSI with a fake Rust ABI peer; prebuilt Hermes/RN dependencies
  and physical-device timing are outside that claim. Refresh these gates for the frozen arms:
  1. Hermes assertion suite re-run on the switched tree:
     `bash examples/react-native-calculator/modules/rustra-jsi/ios/run-hermes-sync-tests.sh` —
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
  ([decision doc rollback strategy](dev/research/2026-09-24-emit-switch-decision.md)).

## 3. rn-experiment — same gzip operation over JSON and bytes

### 3.1 Arms and scope

Compare `gzipCompress` and `gzipDecompress` separately: each operation receives identical
input through JSON and `invokeTypedBuffer` in one release Hermes app. `uuidV7` remains a
correctness example; its latency cannot control for gzip transport cost. Default inputs are
1, 64 and 256 KiB deterministic LCG bytes. The 256 KiB cap keeps the expanded JSON request
inside the native 1 MiB payload limit; a 1 MiB bytes-versus-JSON lane is not valid here.

Native build recipes remain `bash modules/rustra-bridge/ios/build-rust-ios.sh` and
`bash modules/rustra-bridge/android/build-rust-android.sh` from `examples/rn-experiment`.
Physical iOS needs `RUSTRA_IOS_TARGET=aarch64-apple-ios`. The historical simulator
cross-compile [receipt](dev/research/2026-09-24-rn-experiment-ios.md) is not installation or
measurement evidence for the current collector.

### 3.2 Implemented collector; remaining device integration

- `examples/rn-experiment/apps/native-benchmark.ts` exports `runNativeBenchmark(options)`.
  Import it from an installed app that links the generated module. It checks release Hermes,
  installed/generated contract identity, and native bytes capability. It accepts only one
  collection per JS runtime; the platform driver must still prove distinct process restarts.
- `apps/benchmark.ts` serially warms each lane and records individual calls, including JS
  adapter work. Defaults: 5 warmups, 100 samples. It verifies gzip magic, every output byte,
  input immutability and SHA-256 provenance. Supply `sha256`, distinct `launchId`, alternating
  `order: 'json-bytes' | 'bytes-json'`, and observed source/bundle/native hashes and
  device/OS/Hermes/RN metadata. Mark `target` as `physical-device` or `simulator` truthfully.
- Save the returned `BenchmarkReceipt` as one JSON per launch through the app's file/export
  integration. The collector does not install, restart or pull the app. Those platform
  drivers and physical executions remain incomplete. Do not label host transport mocks as
  native evidence.
- Receipts use `schemaVersion: 1`, `evidence: 'react-native-runtime'`, raw `samplesUs`,
  p50/p95, per-lane payload hashes and a runtime ID. Allocation/copy metrics are explicitly
  `null`/`not-instrumented`; request/output sizes are not substitutes for them.

After five real launches, from the repo root:

```bash
env -u RUSTRA_BUN_LIBRARY bun examples/rn-experiment/scripts/benchmark-receipts.ts \
  target/rn-experiment/summary.json \
  target/rn-experiment/launch-1.json target/rn-experiment/launch-2.json \
  target/rn-experiment/launch-3.json target/rn-experiment/launch-4.json \
  target/rn-experiment/launch-5.json
```

The summarizer rejects duplicate runtime/launch IDs, mixed source/device/build metadata,
nonalternating order, incomplete lanes, altered fixtures and unequal outputs. It keeps
per-launch p50/p95 ratios and order groups; its decision remains `measurement-only`.

### 3.3 Sample design and interpretation

Use five independent physical app launches per platform with orders JSON/bytes,
bytes/JSON, JSON/bytes, bytes/JSON, JSON/bytes. Keep all per-call samples, raw receipts,
installation/restart logs and observed binary/bundle hashes. Report simulator cohorts
separately. Do not pool iOS and Android or mix source/build cohorts.

The implemented summary reports JSON/bytes ratios (>1 favors bytes). A causal claim needs
the same operation/input, correctness in every launch and paired per-launch log-ratio
analysis with nominal t(4) 95% intervals excluding 1, plus order-sensitive results. This
confidence interval/adoption analysis is not implemented in the current summarizer; do
not promote `measurement-only` to adoption without completing it. Allocation/copy claims
also require separate instrumentation. If no effect is established, keep the result
inconclusive for that workload rather than generalizing to all buffer routes.

Store raw receipts and the summary under `target/rn-experiment/`; after actual execution,
record the environment, limitations and analysis in
`docs/benchmark-receipts/<date>-rn-experiment-buffer-ab.json`. No physical receipt or
adoption verdict was produced on 2026-10-13.

## 4. Execution order and reporting

1. Freeze the arms and refresh A2 leading gates (§2.1); historical and local passes are recorded there.
2. E1 matrix (§1) — largest expected effect, largest build cost (two full arm builds).
3. A2 matrix (§2.3) — reuses the same installed-app plumbing as E1.
4. Integrate the implemented rn-experiment collector with install/restart/export drivers (§3), then measure on a separate idle device.
5. Append actual evidence to `performance-evaluation.md`; use §0 for E1/A2 and §3 for gzip receipts. The runbook itself is versioned; protocol deviations (device substitution, run loss)
   must be recorded in the receipt's `methodology` block, not silently absorbed.
