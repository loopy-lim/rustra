English | [한국어](./verification-checklist.ko.md)

# Host Verification Manual Checklist

Checks that cannot run in CI (real WebView, real device, reload timing) and
must therefore be executed and recorded by hand. This document is the record
form: fill one block per run, per item. An item without a filled block is not
verified — do not upgrade the evidence level in
[README "Platform Support Matrix"](../README.md) without one.

Automated counterpart: the calculator integration journey test
(`examples/calculator/tests/journey.test.ts`) covers invoke → events →
progress → cancel → unsubscribe → recovery → dispose on the Node loop-stdio
real host. Everything below is the remainder that automation cannot reach.

## How to record

For every item, copy the block and fill it in:

```text
- Item: <item number and title>
- Host: <tauri-calculator / react-native-calculator / other>
- OS: <macOS 26 arm64 / Windows 11 / Ubuntu 24.04 / iOS 26 simulator / Android API 36 / device model>
- Build: <debug / release>
- SHA: <git rev-parse HEAD at run time>
- Date: <YYYY-MM-DD>
- Result: <PASS / FAIL / PARTIAL — per-sub-step notes>
- Evidence: <receipt path / screenshot / log excerpt — optional but recommended>
```

## 1. Tauri real WebView (R01/R02/R03 + profiled non-exposure)

Scope: the Tauri adapter's WebView-only behaviors — the ones whose fixtures
deliberately simulate the boundary and therefore need the real thing.

- [ ] **R01 — callback boundary runs once.** Trigger an event; confirm the JS
      callback executes exactly once (no replay, no double delivery), and that
      a callback that throws does not get re-invoked and surfaces as a
      listener error observation instead.
- [ ] **R02 — Unicode channel name end-to-end.** Publish a Korean-named event
      from Rust (`app.emit`) and receive it on a subscription made with the
      same non-ASCII channel name.
- [ ] **R03 — payload types and values survive the splice.** For object,
      string, and primitive payloads: the real WebView inlines `emit_str` JSON
      as `payload: {…}`, so objects arrive decoded (identity preserved),
      strings get exactly one `JSON.parse`, primitives stay the original
      string under a legacy-string transport but arrive as the primitive under
      the real WebView (the known divergence — confirm which side you are on).
- [ ] **Production registration does not expose profiled dispatch.** In the
      production command registry, profiled dispatch entry points must not be
      reachable; verify by attempting a profiled-only id/command and expecting
      the not-registered failure.

Run: `bun run test:runtime:tauri` (builds and smokes `examples/tauri-calculator`)
plus a manual `bun run --cwd examples/tauri-calculator tauri dev` session for
the interaction steps. macOS first; Linux Tauri is build+smoke evidence only.

```text
- Item: 1. Tauri real WebView (R01/R02/R03 + profiled non-exposure)
- Host:
- OS:
- Build:
- SHA:
- Date:
- Result:
- Evidence:
```

## 2. React Native real host (event shapes, listener exceptions, resubscription)

Scope: the RN adapters (JSON and rkyv V2 JSI) on a real RN runtime.
Simulator level is the current bar; physical-device runs are a separate track —
record what you actually ran in the Build/OS fields.

- [ ] **String events** delivered with content intact.
- [ ] **Primitive events** delivered as primitives (JSON adapter) — note the
      rkyv V2 path's shape for the same payload.
- [ ] **Unicode events** (Korean, emoji) survive encode/decode on both
      adapters.
- [ ] **Listener exception containment** — a subscriber callback that throws
      does not break the sink/drain loop nor other subscribers; the failure is
      observable (listener error path), not silent.
- [ ] **Unsubscribe then re-subscribe** — late emits after unsubscribe are not
      delivered; a fresh subscription receives new emits.

Run: `examples/react-native-calculator` on the iOS simulator and/or Android
emulator, per its README.

```text
- Item: 2. React Native real host
- Host:
- OS:
- Build:
- SHA:
- Date:
- Result:
- Evidence:
```

## 3. Emit-timing policies (host-agnostic)

Scope: the four timing edges every push path (Tauri emit, RN JSI sink, Bun FFI
sink, Node stdout frames) documents. Confirm each on at least one real host
per adapter you ship.

- [ ] **Emit before registration** — an `app.emit` (or host emit) that happens
      before any JS subscription exists. Push paths discard it by contract;
      polling paths may retain it. Confirm which behavior your adapter shows.
- [ ] **Emit after subscribe** — normal delivery, the baseline case.
- [ ] **Emit after unsubscribe** — not delivered, no error, no replay on
      resubscribe.
- [ ] **Late emit right after reload** — an emit racing a dispose/reload cycle
      must not resurrect listeners or crash the host; it may be dropped.

```text
- Item: 3. Emit-timing policies (adapter under test: ____ )
- Host:
- OS:
- Build:
- SHA:
- Date:
- Result:
- Evidence:
```

## 4. A09 — RN physical-device ownership observation (record only)

Scope: after cancel and teardown flows on a **physical** RN device, observe
whether any ownership anomaly remains (retained native handles, callbacks
firing after dispose, memory not released). This item records observations
only — a sanitizer/leak-detection track is separate and not part of this
checklist. No observation is also a result: write "no anomaly observed" or
describe the anomaly.

```text
- Item: 4. A09 RN physical-device ownership observation
- Host:
- OS (device model + OS version):
- Build:
- SHA:
- Date:
- Result:
- Evidence:
```

## 5. A11 prep — registry consumer procedure after publish (documented, not run)

Scope: the procedure to run once a publish is approved. Do **not** execute it
as part of a verification run; this item confirms the procedure is written and
findable.

1. After the npm publish workflow completes green, install the published
   `@rustra/*` versions in a scratch project outside this workspace.
2. Generate the client from the published CLI (`rustra codegen`) against the
   contract of the published `@rustra/types` — not the workspace sources.
3. Run the calculator example's generated-client test against those artifacts.
4. Record versions used and the registry consumer output in the block below.

```text
- Item: 5. A11 registry consumer procedure
- Host:
- OS:
- Build: n/a (published artifacts)
- SHA: <commit whose procedure was followed>
- Date:
- Result:
- Evidence:
```

## Relation to other evidence

- Platform-level evidence summary (what is verified at which level today):
  [README "Platform Support Matrix"](../README.md).
- Feature × adapter capability differences: the
  [compatibility matrix](compatibility-matrix.md).
- Measurement receipts: [docs/benchmark-receipts/](benchmark-receipts/) and
  [docs/benchmarks.md](benchmarks.md). A passing benchmark is not a substitute
  for the behavioral checks above.
