English | [한국어](./library-author-rules.ko.md)

# Library author rules

Rules for people who author Rust commands behind a rustra bridge — the
counterpart of "heavy work off the JS thread" dispatch guidance in other JSI
bridges. Every rule below points at a mechanism that exists in this
repository; nothing here is aspirational.

## 1. Heavy handlers are `async` — the JS thread is never yours

A synchronous command runs its FFI round trip on the calling JS thread.
`async fn` handlers run on rustra's fixed FFI worker pool instead
([function registration](function-registration.md)). Rule: anything that can
take longer than a few hundred microseconds — I/O, locks, loops over large
payloads, compression — is an `async` `#[command]`, not a sync one.

The pool is fixed at 2 workers with a bounded queue of 256 submissions;
overflow is an immediate `invoke.backpressure` rejection, never a hang
(`crates/rustra/src/ffi_pool.rs`). Design handlers to be short-lived so the
two workers drain: if you need long-running work, split it into resumable
steps or drive it behind a channel.

## 2. Don't poll from Rust — emit events

Rust-side polling loops (sleep/inspect/resend) burn worker-pool slots and
add latency to every other command. Emit an event when state changes
([events and channels](events-and-channels.md)) and let the host subscribe.
The polling options you will find in the host matrix (`pollMs`,
`RUSTRA_NODE_EVENT_POLL_MS`) are **fallbacks** for transports that cannot
push — they are not a design pattern for new handlers.

Caveat that follows from the transport contract: push sinks bypass the
event bus, so emits that happen before the first subscription are dropped.
Subscribe first, or rely on polling if pre-subscription emits matter
([compatibility matrix, event delivery path](compatibility-matrix.md)).

## 3. Channels have per-host thread rules — read them before sending

Channel `send` is safe from Rust background threads on Node (stdout frames
arrive as data events), but on Bun it is a `threadsafe:false` FFI callback —
sends must stay on the JS thread. RN channels are unicast with
CallInvoker-driven or `pollMs` drains. The full per-host contract lives in
the [compatibility matrix](compatibility-matrix.md); violating it is a
`channel.unavailable` loud failure at best.

## 4. Cancellation is cooperative and shallow

An aborted `AbortSignal` rejects the JS promise; the Rust handler keeps
running or may already have finished. Handlers that care should poll
`status`-style checkpoints and return `RustraError::cancelled` at them
([typed errors](error-codes.md)). Never assume "promise rejected = command
did not run".

## 5. `retryable: true` is not "safe to re-run"

`retryable` classifies the failure (transports timed out, connection
reset), not the command. A non-idempotent command must not promise
re-execution safety; consumers are expected to re-read state before
retrying. Document idempotency per command if consumers will retry.

## 6. Capability gating is opt-in per command

A command declared without `capability = "…"` is callable by any JS that
reaches the bridge — the default posture of a fresh package is allow. Grant
capabilities only via `Package::grant_capability`, and declare a capability
for anything privileged (file, network, process). This is a documented
open trade-off of the current design ([threat model](threat-model.md)).

## 7. Size gates are part of the contract

Payloads are rejected before the copy above the size gate (default
1 MiB, dynamically configurable — `crates/rustra/src/limits.rs`,
`payload.too_large`). Design commands for bounded payloads; stream larger
data through channels/events instead of growing the frame.

## 8. Errors cross the boundary structured — keep them that way

Handler errors become `{ code, message, retryable }` error frames; a panic
is normalized to `internal` and never crosses as a crash
([error codes](error-codes.md)). Throw `RustraError` factories with stable
codes instead of formatting ad-hoc messages — consumer code branches on
`code`. Do not put heap addresses, backtraces, or secrets into messages.

## Provenance

| Rule | Backed by                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------- |
| 1    | `crates/rustra/src/ffi_pool.rs`, [function registration](function-registration.md)             |
| 2    | [events and channels](events-and-channels.md), [compatibility matrix](compatibility-matrix.md) |
| 3    | [compatibility matrix](compatibility-matrix.md), `docs/adr/0004-ffi-safety-preconditions.md`   |
| 4    | `crates/rustra/src/cancel.rs`, [typed errors](error-codes.md)                                  |
| 5    | generated `InvokeOptions` JSDoc, [compatibility matrix](compatibility-matrix.md)               |
| 6    | `crates/rustra/src/registry.rs`, [threat model](threat-model.md)                               |
| 7    | `crates/rustra/src/limits.rs`, `payload.too_large`                                             |
| 8    | `crates/rustra/src/error.rs`, [error codes](error-codes.md)                                    |
