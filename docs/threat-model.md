English | [한국어](./threat-model.ko.md)

# Threat model (A06)

Status: first edition — 2026-09-07. Deferred item A06 of the stabilization
track (`docs/plans/2026-09-05-stabilization-unified.md`: "위협 모델 — 격리
요건이 생길 때"). This document invents no mitigations: every "Mitigated by"
entry points at code that exists in this repository today. Anything not
backed by code is listed under [Open gaps](#open-gaps).

## Scope

rustra-bridge is a Rust engine plus a TypeScript bridge layer that lets JS
runtimes (Node, Bun, Tauri WebView, React Native) call into compiled Rust
command handlers over a binary FFI boundary. The assets and boundaries below
cover the repository as shipped: `crates/rustra`, `packages/*`, generated
clients, and the CI/CD surface.

Out of scope: the security of the host OS, the WebView engine, or the JS
runtime itself; application-level authz inside user command handlers
(rustra's capability system is the boundary rustra owns).

## Assets

| ID | Asset | Why it matters |
|----|-------|----------------|
| A1 | Rust command handlers (native logic, file/net/process access the host grants) | Highest-privilege code in the process |
| A2 | Process memory across the FFI boundary | A single wrong-length free or OOB read is memory corruption in the host app |
| A3 | The wire protocol (rkyv V2 / JSON frames) | Parser bugs = memory safety bugs in Rust |
| A4 | The event channel (`rustra://…`) | Leaks handler output; spoofable broadcasts confuse app state |
| A5 | The global engine slot (versioned `Symbol.for` keys) | Whoever owns it routes every `invoke` in the JS realm |
| A6 | Supply chain (crates.io deps, npm deps, generated code) | Compromise ships inside every consumer app |

## Trust boundaries

1. **JS → Rust FFI entry points** (`rustra_ffi_invoke*` family,
   `crates/rustra/src/ffi*.rs`). Every byte arriving here is untrusted,
   including lengths: the payload size gate runs *before* the copy
   (`ffi_async_entries.rs`, `max_payload_bytes()` in `limits.rs`).
2. **JSI boundary** (React Native, `packages/react-native/src/`). The JSI
   surface (`RustraJSINative`: `invoke(ArrayBuffer)`, `onEvent`, `createChannel`,
   `dropChannel`) has no origin/permission isolation — any JS loaded into the
   RN context can call it. rustra's defense is on the Rust side (A1
   capability checks), not the JS side.
3. **Rust → JS event push** (`events.rs`, Tauri `emit`, RN
   `DeviceEventEmitter`). Broadcast trust model: every listener in the JS
   realm receives every `rustra://` event.
4. **Deserializer** (`rkyv_decode.rs`, JSON paths in adapters). Untrusted
   input by definition — the rkyv V2 decoder is a hand-written, bounds-checked
   cursor decoder (length prefixes checked against `payload.len()` before
   every slice, `from_utf8` validation).
5. **Codegen / build pipeline** (`packages/cli`). `schema.json` is the single
   source of truth; generated files are guarded by codegen `--check` and the
   `.rustra-generated.json` manifest.

## STRIDE mapping

| Threat (STRIDE) | Where | Mitigated by (actual code) | Residual |
|---|---|---|---|
| **S** — Spoofing: forged event delivery | JS listeners on `rustra://` channels | `event_channel()` prefixes every channel with `rustra://` and `sanitize_event_name()` (`tauri_support.rs`) whitelists Unicode alphanumerics + `-/:/_`; events carry only handler-emitted payloads | Any JS in the realm can *listen* and, via the host emitter, *emit* onto the namespace — no per-event origin authentication. Same-realm trust assumption — **open** |
| **S** — Spoofing: hijacking the global engine slot | `Symbol.for` globals (`global-state.ts`) | Keys are **versioned** (`dev.rustra.types.v0.4.0.*`) so mismatched versions do not cross-talk | Last-registered bootstrap wins (R08 in the stabilization doc); cross-library slot squatting within one realm is **open** |
| **T** — Tampering: malformed invoke frames | FFI entry points | Size gate before copy (`payload.too_large`, default 1 MiB, `limits.rs`); `command_id` resolved against the frozen registry (`command.not_found`, `invoke_dispatch.rs`); args decoded with per-field validation (`command.invalid_args`) | None known on these paths |
| **T** — Tampering: crafted rkyv V2 payloads | `rkyv_decode.rs` | Hand-written bounds-checked cursor decode (no `unchecked` transmutes of untrusted bytes); UTF-8 validation per string field; weekly fuzz (`fuzz.yml`, seeded corpus, 10-min run on `invoke_rkyv_v2`); weekly miri on core logic (`miri.yml`) | Fuzz/miri are experimental tracks (`continue-on-error`), not gates — coverage is best-effort. **Open (accepted)** |
| **T** — Tampering: OTA/client mismatch routing | command_id aliasing (`builder_capabilities.rs`) | Aliases that would shadow another command's real id are rejected at declaration/build time (panic — loud, not silent) | None known |
| **R** — Repudiation | invoke/audit trail | Out of scope: rustra is a library; no built-in audit log. Hosts that need repudiation evidence must log at their own boundary | **Open by design** |
| **I** — Information disclosure | error frames, event payloads | Error frames carry structured `code` + message (`error.rs`) — no raw pointers, no heap addresses, no backtraces cross the boundary | Handler-authored messages flow through verbatim; leak discipline is the handler author's responsibility — **open (documented expectation)** |
| **D** — DoS: overload of the native side | async FFI pool | Fixed pool (2 workers) + bounded queue (256) with immediate `invoke.backpressure` rejection — no hang, no thread explosion (`ffi_pool.rs`); payload size gate; event bus drop-oldest with `dropped` counter (1024 cap, `events.rs`) | Pool/queue constants are fixed, not per-host tunable; no overload *telemetry* existed until the A08 counters (`async_pool_stats()`). Executor tuning deferred pending measurements — **open (A08 remainder)** |
| **D** — DoS: memory exhaustion via buffers | caller-buffer `_into` paths | Capacity-checked writes with heap-frame fallback (`ffi_typed_async.rs`); `payload.too_large` pre-copy | None known |
| **E** — Elevation of privilege: calling capability-gated commands | Registry dispatch | **Deny-by-default**: a command with `required_capability` returns `capability.denied` *before* the handler runs (`registry.rs`); grants only via `Package::grant_capability`; registry frozen after `build()` (structural mutation rejected, grants allowed) | Capability gating is **opt-in per command** — commands declared without `capability = "…"` are callable by any JS that reaches the bridge. This is the documented contract, but it means the default posture of a fresh package is allow — **open (design decision, revisit with isolation requirements)** |
| **E** — Memory-safety EoP via FFI misuse | `rustra_ffi_free` | Debug-only allocation tracker classifies wrong-len / double-free / foreign-pointer frees and aborts loudly (`ffi_free_guard.rs`) | Tracker compiles out in release — release builds cannot soundly defend against a hostile *caller* misusing `unsafe` FFI. **Open (fundamental FFI limitation, documented in-source)** |
| **E** — Supply chain compromise | crates.io / npm deps | CI gates: `cargo audit --deny warnings` with a fixed upstream-exception list (`scripts/audit-rust.sh`, both lockfiles), `cargo-deny` for licenses/bans/sources (`ci.yml`); lockfiles committed | No equivalent npm-side advisory gate (e.g. `bun pm audit`) in CI — **open**; generated-code integrity relies on git + manifest, no signing — **open** |

## Boundary-by-boundary summary

- **Untrusted JS input at FFI**: size gate → registry lookup → schema decode
  → capability check → handler. Each failure mode has a stable error code
  (`payload.too_large`, `command.not_found`, `command.invalid_args`,
  `capability.denied`, `invoke.backpressure`, `transport.*`, `cancelled`)
  so the JS layer can normalize without guessing (`normalizeRustraError`,
  `errors.ts`).
- **Deserialization (rkyv V2 / JSON)**: rkyv V2 decode is fully manual and
  bounds-checked; JSON paths live in the adapters and go through standard
  parsers plus `parseRustraErrorString` for error frames. The rkyv path is
  the fuzz target; JSON parsing errors surface as typed errors, not
  exceptions across FFI.
- **RN JSI**: the JSI module is intentionally thin; all trust decisions are
  made in Rust. JS-side `exactArrayBuffer` validation guards shape before
  crossing.
- **Event channel spoofing**: namespace + sanitization prevent accidental
  collisions and cross-talk with host events; deliberate same-realm spoofing
  is out of model (see open gaps).
- **Supply chain**: audit + deny gate Rust deps; npm side open.

## Open gaps

1. **Same-realm trust**: any JS in the WebView/RN context can invoke the
   bridge and subscribe to (or, via the host emitter, emit onto) `rustra://`
   channels. Mitigating this requires per-realm isolation requirements that
   do not exist yet — exactly why A06 was deferred ("격리 요건이 생길 때").
2. **Capability gating is opt-in**: no global "deny un-gated commands"
   switch exists.
3. **Global engine slot**: last-bootstrap-wins (R08); loud-fail guard is
   planned on the stabilization track, not present here.
4. **Release-build FFI misuse**: free-guard is debug-only by design.
5. **npm dependency advisories** are not gated in CI.
6. **Fuzz/miri/ASan are experimental tracks** (`continue-on-error`), not
   mandatory gates; findings are harvested manually.
7. **Overload telemetry beyond counters**: A08's minimal slice
   (`rustra::ffi::async_pool_stats()`) measures submit/reject/complete
   counts; queue-depth histograms, per-command attribution, and executor
   tuning remain future work pending measurement evidence.

## Maintenance

Revisit this document when: a new trust boundary is added (new host adapter),
the wire format changes, or any open gap above is closed. The
STRIDE table's "Mitigated by" column must always name real code paths — if a
mitigation is removed, move its row to Open gaps in the same change.
