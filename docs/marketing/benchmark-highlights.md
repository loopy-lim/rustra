# Benchmark Highlights

A one-page summary of rustra's verifiable performance claims for external
marketing (Show HN, README, blog posts). Every number below is quoted from
existing, in-repo evidence — no new measurements were run for this page. Each
claim lists its source document, the raw receipt behind it, its measured scope,
and how to reproduce it.

Run [`verify-benchmark-claims.sh`](./verify-benchmark-claims.sh) to check that
every file cited here exists and every quoted figure still appears verbatim in
its source document or receipt.

## Ground rules for quoting these numbers

- Name the layer. A payload-byte ratio is not an end-to-end RTT ratio, and an
  FFI micro figure is not a user-path latency
  ([wire-format.md](../wire-format.md) explains this scoping in detail).
- All figures come from a single Apple Silicon machine (M1 Max class, macOS,
  release builds) unless the source says otherwise. They are medians or trimmed
  means of documented runs, not p95 guarantees, and not physical-device or
  Windows/Linux claims.
- Per the [benchmarks](../benchmarks.md) policy: after measurement code changes,
  past numbers are not treated as execution evidence of the current checkout.
  Re-run the documented commands to refresh them.

---

## Claim 1 — The Frame wire is ~11.8× smaller than JSON on request bytes

One representative command payload (`addNumbers`) measures **4 B on the Frame
wire versus 47 B as JSON** — a request wire ~11.8× smaller. This is a payload
bytes ratio only: it excludes framing, transport overhead, and the response,
and **is not an end-to-end RTT claim**.

- Evidence: [benchmarks.md wire benchmark table](../benchmarks.md#2026-08-22-full-re-measurement-030-preparation-checkout)
  (JSON request 47 B, Frame request 4 B) and the scoped write-up in
  [wire-format.md](../wire-format.md) ("The 11.8× / 47 B claim, scoped").
- Reproduce: `cargo run -p rustra-calculator-example --bin wire-bench --release`
  (see [benchmarks.md](../benchmarks.md) and the measurement policy in
  [measurement-runbook.md](../measurement-runbook.md)).

## Claim 2 — Core Frame round trip: 134 ns, ~8.9× faster than JSON

The same wire benchmark clocks the Rust core round trip
(`Package::invoke_frame`) at a **134 ns mean / 125 ns p50 — 7,442,853 ops/s**,
versus 1.19 µs for the JSON `invoke` path (~8.9× faster; postcard sits between
at 433 ns). This is core dispatch only — no JS host, transport, or WebView cost
is included.

- Evidence: [benchmarks.md wire benchmark table](../benchmarks.md#2026-08-22-full-re-measurement-030-preparation-checkout),
  measured 2026-08-22, Rust release build.
- Reproduce: `cargo run -p rustra-calculator-example --bin wire-bench --release`.
  Host-level latencies (which include transport) are a separate table — see
  Claim 5.

## Claim 3 — The 0.10.2 codec patch cut recursive round trips by 78.66% and allocations by 86%

The 0.10.2 core performance patch (2026-09-16, A/B against published 0.10.1,
five independent processes per variant, alternating AB/BA) reduced the
`recursive_depth_8` case from **4,455.16 ns to 950.55 ns (−78.66%)** while
requested allocation calls fell **from 81 to 11 per call**. The 64 KiB optional
string case halved: **13,453.30 ns → 6,678.66 ns (−50.36%)**, allocations
6 → 4.

This is not an across-the-board speedup: oneOf data enums got 9.60% slower and
64-key maps 6.24% slower — all within the declared 10% regression budget, and
reported as controls rather than hidden.

- Evidence: raw A/B receipt
  [2026-09-16-patch-performance-ab.json](../benchmark-receipts/2026-09-16-patch-performance-ab.json)
  (all 10 runs, request sizes, allocation counts, source/binary hashes), tables
  and caveats in [benchmarks.md](../benchmarks.md#0102-core-performance-patch-2026-09-16),
  verification record
  [verification/2026-09-16-patch-performance.md](../verification/2026-09-16-patch-performance.md).
- Reproduce: check out 0.10.1 and the patch, then run
  `python3 scripts/benchmark-complex-ab.py` with the two checkout roots
  (full procedure in [benchmarks.md](../benchmarks.md#0102-core-performance-patch-2026-09-16)).
  Device/on-device follow-up measurements follow
  [measurement-runbook.md](../measurement-runbook.md).

## Claim 4 — Tree workloads: 8,191-node round trip 25.81 ms → 8.68 ms

Across seven tree shapes, whole-tree round trips improved by
**63.50–66.38%** and full-input searches by **59.80–63.92%** in the same
2026-09-16 A/B. The largest fixture (`balanced8191`, 8,191 nodes) dropped from
**25,805.35 µs to 8,675.21 µs** for echo and **13,235.35 µs to 4,775.80 µs**
for search. A read-only _resident_ query on that same tree takes **20.459 µs** —
a different application data-lifetime pattern (send an index, not the tree),
documented as such rather than folded into the speedup claim.

- Evidence: raw receipt
  [2026-09-16-tree-performance-ab.json](../benchmark-receipts/2026-09-16-tree-performance-ab.json),
  tables in [benchmarks.md](../benchmarks.md#branching-trees-and-search).
- Reproduce: the same A/B script with `--suite tree` (build
  `--bench tree_route` and `--example tree_allocations --release` in both
  checkouts; procedure in
  [benchmarks.md](../benchmarks.md#branching-trees-and-search) and
  [measurement-runbook.md](../measurement-runbook.md)).

## Claim 5 — Real host API: a Node server hot path gains ~164× (loop) to ~2,188× (N-API Frame)

The 2026-08-24 host matrix calls real generated entry points in real runtimes
(`addNumbers({a: 42, b: 58})`, trimmed-mean of 3 repeats, release builds):

| Path                        |       Mean | Throughput |
| --------------------------- | ---------: | ---------: |
| Node generated one-shot     |   2.758 ms |      363/s |
| Node persistent loop        |  16.863 µs |   59,301/s |
| Node N-API Frame            |   1.261 µs |  793,185/s |
| Bun generated FFI Frame     |   2.273 µs |  439,961/s |
| Tauri generated WebView IPC | 279.044 µs |    3,584/s |

That is a **~164× mean-latency cut** moving from Node one-shot to the
persistent loop, and **~2,188×** to the N-API Frame path — the same contract,
different transports.

- Evidence: raw receipt
  [2026-08-24-host-matrix.json](../benchmark-receipts/2026-08-24-host-matrix.json)
  (per-run warmup/iterations/repeats, p50/p95/p99, normalization), table and
  design conclusions in
  [benchmarks.md](../benchmarks.md#2026-08-24-real-host-api-performance-040-merge-candidate).
- Reproduce: `bun run bench:hosts -- --output /tmp/rustra-host-matrix.json`
  (macOS; environment recorded in the receipt).

---

## Scoped context — React Native: Nitro-grade on the same public object API

On an iPhone 17 Simulator Release app (Hermes, RN 0.81.5 + Expo 54, 2026-08-24),
the 3-run median of equivalent-operation ratios versus a real Nitro HybridObject
was **add 1.0418×, string 1.0281×, bytes 0.9543×, pair 1.0535×** — parity within
±5% on the same JS input/output shapes, with output equivalence verified before
timing. This comparison does not cover physical devices, Android, or feature
parity; the honest boundaries are listed in
[benchmarks.md](../benchmarks.md#nitro-modules-comparison--what-is-and-is-not-measured).
Planned device-grade A/B measurements are specified in
[measurement-runbook.md](../measurement-runbook.md).

## What these numbers do not claim

- No end-to-end RTT ratio is derived from the 11.8× payload figure.
- No physical-device, Android, Windows, or Linux performance claims.
- No p95 tail-latency or energy claims for the core benches.
- Receipts identify the machine, compiler, and source hashes they were produced
  with; they are evidence for those runs, not guarantees for every checkout.
