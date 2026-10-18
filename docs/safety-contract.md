English | [한국어](./safety-contract.ko.md)

# rustra FFI Safety Contract

Status: active · adopted 2026-09-11 · for the change rule see the final section
["If this document changes"](#if-this-document-changes).

## 1. Umbrella Invariant

For a host that satisfies the FFI's unsafe memory and ABI preconditions, malformed
or adversarial **payload bytes** must not cause undefined behavior. Callers must
supply valid, suitably aligned readable/writable ranges, keep borrowed buffers and
callback state alive for the required lifetime, avoid conflicting access, and free
an owned result through its matching allocator exactly once. Null is allowed only
where the entry point documents it. An in-process unsafe API cannot validate an
arbitrary pointer's provenance or lifetime; violating these preconditions can be UB.

Within this boundary, payload validation rejects malformed/oversized input before
handler execution, guarded Rust unwinds are contained, and debug ownership checks
abort on detected misuse. A header magic value is a consistency check on valid
memory, not proof that an arbitrary address is readable. C++ callbacks must contain
foreign exceptions in the host wrapper before returning to Rust (S2). Resource
exhaustion and `panic=abort` are not recoverable error-frame guarantees. These
boundaries, with the unchanged public ABI, are recorded in [ADR 0004](adr/0004-ffi-safety-preconditions.md).

## 2. Per-Item Contracts

### S1. Guarded Rust panic containment

- **Invariant**: guarded command/serialization paths catch unwinding Rust panics with
  `catch_unwind` and normalize them into an `ok:false` error frame. Event sink
  panics are logged and the event is dropped; void registration entries cannot
  return a response frame. This applies to `panic=unwind`, not `panic=abort`. The panic message is serialized in a single
  format, `internal: panic — <payload>` — host parsers classify on the prefix, so the
  format must not diverge per path.
- **Evidence**: `crates/rustra/src/ffi_dispatch.rs:29-48` (`with_panic_guard` —
  `catch_unwind(AssertUnwindSafe)` → `FfiResponse { ok:false }`),
  `crates/rustra/src/ffi_buffer_entries.rs:34-40` (`panic_frame_message` — single format),
  `crates/rustra/src/ffi_buffer_entries.rs:12-18` (same guard on the caller-buffer path),
  `crates/rustra/src/ffi_typed_buffer.rs:67,103` (Frame buffer path →
  `RustraError::internal`), `crates/rustra/src/ffi_event_entries.rs:44,77`
  (event sink register/unregister paths).
- **On violation**: the host receives a normally returned error frame
  (`internal: panic — …`). The supported guarded path returns to its caller. A Rust panic from a
  non-unwinding host callback or an aborting panic is not catchable recovery.
- **Verified by**: `crates/rustra/tests/trust_baseline_ffi.rs:609,613` (panic frame prefix
  assertion), `crates/rustra/tests/payload_robustness.rs` (hostile payloads converge into a
  clean `RustraError` without abort/panic), `crates/rustra/src/events_tests.rs:88`
  (`panicking_sink_does_not_propagate`), `crates/rustra/src/ffi_tests.rs:374-385`
  (emit keeps working after a panicking C callback).

### S2. Foreign exceptions stay inside the host callback

- **Invariant**: C++ callbacks must catch exceptions before returning to Rust. A
  `noexcept` wrapper can record an error and return normally, or deliberately call
  `std::abort` for an unrecoverable condition. It must not let an exception unwind
  into Rust. `C-unwind` permits unwinding at the ABI level; it does not guarantee
  foreign-exception recovery or a specific abort outcome in Rust `catch_unwind`.
  A foreign exception entering a non-unwinding ABI is UB. The host-side wrapper,
  not a promise about Rust catching C++ exceptions, enforces this contract.
- **Evidence**: `crates/rustra/src/ffi_event_entries.rs` documents the callback
  obligation. [Rust's FFI and unwinding rules](https://doc.rust-lang.org/nomicon/ffi.html#ffi-and-unwinding)
  and [`catch_unwind` notes](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html#notes)
  define the language boundary. Rust callback-panic containment is a separate test.
- **On violation**: no recovery or defined-abort guarantee is made for an escaping
  foreign exception. A deliberate abort in the C++ wrapper is defined by that wrapper.
- **Verified by**: `bash scripts/run-foreign-exception-check.sh` builds a C++ host
  against the production Rust event sink. An actual C++ throw is caught before
  returning to Rust: one case records it and receives a second event; another
  explicitly aborts in an isolated child and requires SIGABRT plus the diagnostic.
  It does not execute cross-boundary UB to claim that UB is safe. This harness
  covers macOS/Linux, not every foreign language, ABI, or platform.

### S3. Buffer ownership: 8-byte header, paired free, `usize::MAX` sentinel

- **Invariant**:
  1. Owned responses on the headered invoke paths carry an 8-byte header — magic
     `0x52555354` ("RUST") + `u32 LE` payload length. The returned pointer points at the
     payload **after** the header, and ownership is transferred to the host (boxed slice).
     Caller-owned output buffers and borrowed channel callbacks do not transfer
     such ownership; hosts must not free their pointers as owned responses.
  2. Freeing must use the matching function exactly once: headered buffers go through
     `rustra_ffi_free(ptr, len)`; the headerless boxed slice from `rustra_ffi_invoke_buffer`
     goes through `rustra_ffi_free_owned_bytes(ptr, len)`. The two are not interchangeable.
     `rustra_ffi_free` checks and invalidates the header magic before releasing a
     valid allocation; reading that header already requires valid allocation memory. In debug builds a live-allocation tracker
     aborts loudly with a diagnostic on misuse (WrongAllocator/WrongLen/NotLive); in
     release the guard compiles out — the caller contract is documented instead.
  3. In the caller-buffer two-step protocol (probe → write), an insufficient target buffer
     is left untouched and reported with a `usize::MAX` return demanding a re-probe —
     no partial writes, no truncation.
- **Evidence**: `crates/rustra/src/ffi_prelude.rs:94-115` (`FFI_MAGIC`, `alloc_response`),
  `crates/rustra/src/ffi_prelude.rs:120-128` (`alloc_owned_bytes`),
  `crates/rustra/src/ffi_lifecycle_entries.rs:110-146` (`rustra_ffi_free` — magic check,
  invalidation, debug abort), `crates/rustra/src/ffi_lifecycle_entries.rs:156-173`
  (`rustra_ffi_free_owned_bytes`), `crates/rustra/src/ffi_free_guard.rs` (debug Verdict
  classification), `crates/rustra/src/ffi_sync_entries.rs:85-133` (`usize::MAX` re-probe
  sentinel), `crates/rustra/src/ffi_typed_buffer.rs:19-93` (same sentinel).
- **On violation**: wrong pairing, wrong length, or a non-live pointer is diagnosed
  and aborted by the debug tracker. In release, invalid pointers and double frees
  can be UB before the magic is inspected; no safe no-op is promised. A valid
  readable allocation with unexpected magic is rejected, but this does not validate
  provenance or lifetime. The exact returned pointer/length remains the caller contract.
- **Verified by**: `crates/rustra/src/ffi_free_guard.rs:76-96` (Verdict unit tests),
  `crates/rustra/tests/trust_baseline_ffi.rs` (round-trip frees), `crates/rustra/tests/ffi_process_contract.rs` (actual Unix debug child-process
  aborts for both allocators, wrong lengths, double free, and a foreign pointer;
  correct allocator pairing also runs in release). Misuse is not executed in release.

### S4. Payload limits: the `max_payload` gate

- **Invariant**: an encoded request payload above the dynamic limit (default 1 MiB) is
  rejected before any native handler runs, as a `payload.too_large` error frame
  (non-retryable — a deterministic client condition). The limit is read dynamically at
  runtime (`rustra_ffi_set_max_payload`/`get`). On the TS side the same code rejects in a
  pre-check **just before** the native call (the native dynamic limit remains the final
  gate — the TS pre-check only saves a round trip and is not a separate contract).
- **Evidence**: `crates/rustra/src/limits.rs:6-20` (1 MiB default + dynamic atomic limit),
  `crates/rustra/src/ffi_buffer_entries.rs:4-6,122-125` (Rust-side gates →
  `RustraError::payload_too_large`), `crates/rustra/src/error.rs:127-130` (code ·
  non-retryable), `crates/rustra/src/ffi_lifecycle_entries.rs:80-94` (limit FFI symbols),
  `packages/types/src/frame-engine-contract.ts:39-54` (`payloadTooLargeError` TS pre-gate).
- **On violation**: oversized payloads get
  `payload.too_large: payload NB exceeds max payload MB` — the handler never runs.
- **Verified by**: `crates/rustra/tests/payload_robustness.rs`, `crates/rustra/src/error_tests.rs:15`
  (non-retryable pinned), `packages/types/src/index.test.ts:2246` (no native call on
  over-limit), `packages/react-native/src/index.test.ts:469-490` (pre-check forwarding).

### S5. Hot core (experimental): poison, fail-closed publish, no dlclose

- **Invariant** (the hot-core feature is an experimental surface; its contract is pinned
  as these three rules):
  1. **Per-byte poison**: when consecutive swap failures for the same sha256 bytes reach
     the cap (5), those bytes are marked poisoned and no longer retried until new bytes
     are published — the failure loop cannot degenerate into event storms and wasted
     subprocess spawns. Poison is judged per byte (hash) — new bytes always get a fresh
     retry window. Each swap attempt is wrapped in `catch_unwind` so a broken artifact's
     panic cannot kill the watch thread.
  2. **Fail-closed publish**: `rustra dev` atomically publishes only gate-passing builds to
     the watched `<stem>-hot-live<ext>` path (tmp copy → rename). On gate rejection the
     reload signal is never emitted and the live path is untouched — the host keeps running
     the previously published core.
  3. **No dlclose**: an opened cdylib is never unloaded (pinned `'static` via `Box::leak`).
     macOS is a no-op for dlclose due to std TLS, and on Linux dlclose would make old
     symbol pointers use-after-unload, so leaking one mapping per version copy per session
     is the accepted dev-environment policy. Dropping a core rotated out by a swap does not
     dlclose.
- **Evidence**: `crates/rustra/src/hot_core_watch.rs:58` (`MAX_SWAP_FAILURES_PER_BYTES = 5`),
  `crates/rustra/src/hot_core_watch.rs:64-99` (`FailureTracker` — per-byte poison),
  `crates/rustra/src/hot_core_watch.rs:147-177` (`attempt_swap` catch_unwind),
  `packages/cli/src/dev.ts` `runConfigDev` (gate rejection → no reload emit, live
  untouched; `publishGatedArtifact` only on pass), `packages/cli/src/dev-dylib.ts:191-207`
  (the `-hot-live` path convention), `crates/rustra/src/hot_core_dylib.rs:6-13,125`
  (the no-dlclose leak contract), `crates/rustra/src/hot_core_dylib.rs:309-330`
  (macOS ad-hoc re-sign — failures propagate loudly).
- **On violation**: poisoned bytes wait quietly (one log line) and resume on new bytes. A
  gate-rejected build stays in the cargo target directory. No unload path exists (the type
  is `'static`).
- **Verified by**: `crates/rustra/src/hot_core_tests.rs:57-97` (poison cap and new-byte
  resumption), `packages/cli/src/dev-parity-wiring.test.ts:569+` (only gate-passing builds
  reach the live path), `examples/hot-core-probe` (standalone verifier — host/iOS
  simulator/Android emulator).

### S6. The error envelope always converges to the same shape

- **Invariant**: FFI responses serialize into one of the defined envelopes regardless of
  path — JSON `{"ok":bool,"result":...,"error":string|null}`, postcard `FfiPostcardResponse`
  (`result_json`/`error` embed JSON strings), and Frame uses the
  `[ok][pad][len u16][postcard {code, message}]` framing (errors are `ok=0`, no payload
  field). The JSON fallback re-splits a Rust `Display` string into `{code, message}` at the
  first `": "`. Serialization failure uses hardcoded minimal error bytes. This is a
  response-format guarantee within the umbrella preconditions, not a guarantee of
  delivery after host teardown. Closing a retained async channel suppresses later
  native delivery while Rust still frees the response; the host must settle its own
  pending work when disposing the channel. A foreign runtime such as scriptc may
  still drain callbacks copied into its queue before release. Consumers must guard
  effects on disposed state separately from native registration teardown.
- **Evidence**: `crates/rustra/src/ffi_prelude.rs:60-81` (`FfiResponse`,
  `FfiPostcardResponse`), `crates/rustra/src/ffi_dispatch.rs:74-77` (JSON encode failure
  fallback), `crates/rustra/src/hot_core_dylib.rs:223-228` (`split_error_wire` — Display
  re-split), framing contract in `docs/wire-format.md:84-94`, code registry in
  `crates/rustra/src/error.rs:23` (table) + `packages/types/src/errors.ts:156`.
- **On violation**: an undecodable frame normalizes to `invoke.failed` on the host side
  (`crates/rustra/src/hot_core_dylib.rs:159-175`,
  `packages/types/src/frame-engine-contract.ts:12-34` `tier2Outcome` — even a codec throw
  converges into a rejection; a promise never stays unsettled).
- **Verified by**: `crates/rustra/tests/trust_baseline_ffi.rs` (3-corner pinned hex),
  `docs/wire-format.md` (the byte-level contract document), `packages/types/src/index.test.ts`
  (error code parsing and re-splitting).

### S7. Fail-closed gate philosophy

- **Invariant**: "a contract that cannot be verified is not a contract" — enforcement
  machinery never passes on a suspect state. (a) Runtime contract verification: under
  the default policy (`contractVerification: 'strict'` — `undefined` behaves the same),
  when a consumer passes `contractHash`, a hash mismatch fails fast with
  `contract.mismatch` (and if the native side cannot produce a hash at all,
  `contract.unenforceable` — not even a callback bypasses it). The
  `contractVerification` option is the single explicit, caller-owned escape hatch:
  `'warn'` downgrades those failures to a console warning and continues in degraded
  mode, and `'off'` skips verification even when `contractHash` is set. It applies only
  to the native Frame engine and never turns verification on by itself — without
  `contractHash` there is nothing to verify. (b) The dev parity gate is default-on for
  wasm/dylib targets, and a gate rejection means the reload signal itself is never
  emitted (the host keeps its current engine). (c) Android hot-core watching activates
  only in `FLAG_DEBUGGABLE` builds — release builds never spawn a watch thread. (d)
  `scripts/docs-gate.mjs` reports marker-contract violations and drift fail-closed, and
  also enforces ko mirror completeness.
- **Evidence**: `packages/types/src/frame-engine-contract.ts:61-163`
  (`validateFrameEngineOptions` — mismatch/unenforceable),
  `packages/types/src/frame-engine-options.ts:64` (the `contractVerification` policy
  knob), `packages/cli/src/dev.ts` `runConfigDev`
  (parity-gate fail-closed publish), Android gate:
  `examples/react-native-calculator/modules/rustra-jsi/android/src/main/java/dev/rustra/bridge/RustraBridgeModule.kt:35`
  (iOS is symmetric via the `RUSTRA_HOT_CORE_DIR` env gate), `scripts/docs-gate.mjs`.
- **On violation**: gates fail instead of passing — engine creation refused, reload not
  emitted, CI exit 1. "Skip verification and continue" exists only when the caller
  explicitly opts in via the `contractVerification` policy — never silently.
- **Verified by**: `packages/types/src/index.test.ts` (mismatch/unenforceable paths),
  `packages/cli/src/dev-parity-wiring.test.ts`, `scripts/docs-gate.test.ts`.

## If this document changes

Any change in meaning to any item of this contract (S1–S7 and the umbrella invariant
alike) — strengthened, weakened, or reinterpreted — **requires a new ADR in `docs/adr/`**
(see `docs/adr/README.md` for the format). If the code and this document diverge, that is
a bug: even a commit that moves the document toward reality is a contract change and gets
an ADR. Moving **line numbers** in evidence paths (same contract, different lines) may be
updated without an ADR.
