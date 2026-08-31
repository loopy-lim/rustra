---
'@rustra/cli': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/types': minor
'@rustra/devtools': minor
'@rustra/tauri': patch
'@rustra/testing': patch
'@rustra/react': patch
'@rustra/react-native': patch
---

Next-cycle integration: hot-reload track + inspector track.

**Hot-reload track (dev-time):** `rustra dev` gains a reload hook on its watch
handle, a parity gate for the wasm dev target (fail-closed, rejects reloads on
contract drift), wasm32 engine build orchestration (`[dev:wasm]` artifact
logging; device push is the host's integration point), a doctor notice for the
experimental wasm target (cooperative cancellation only — verify natively
before release) plus a required `wasm32-unknown-unknown` rustup target check,
and a release-coherence rule excluding the wasm backend from release artifacts.
`@rustra/node` adds `NodeLoopTransport.drain(timeoutMs)` (optional member) and
reload support on both bootstraps (loop hosts: graceful drain; one-shot:
shallow cancel); `@rustra/bun` reload re-initializes engine state in-process
with a loud dlopen-cache warning. The experimental `rustra_ffi_hot_reload` FFI
(replace semantics, loud skip report) lands in `rustra` — Rust-only, no npm
surface.

**Inspector track:** `rustra_ffi_capture_snapshot` FFI plus
`parseSnapshot`/`serializeSnapshot` in `@rustra/types`, the `rustra inspect`
CLI for dump files, a self-contained `renderTimelineReport` HTML generator in
`@rustra/devtools`, and contract-diff diagnosis in the existing
`onContractMismatch` info.

**Type-level breaking changes in `@rustra/cli` (pre-1.0 minor, no migration
action required beyond recompiling):**

1. The `BreakingChange` union gains a new member `command_id_changed`.
   Exhaustive switches over `BreakingChange` (e.g. `satisfies never` checks)
   must add the new case.
2. `DiffResult.diagnoses` becomes a REQUIRED field (always present, possibly
   empty). Code reading `result.diagnoses?.…` keeps working; code doing
   `in`-checks or exact-shape comparisons must drop the optionality
   assumption.
