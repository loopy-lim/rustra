[한국어](./error-codes.ko.md)

# Error Codes

The complete reference for the `RustraErrorCode` registry — every error code that
`@rustra/types` (`packages/types/src/errors.ts`) and the Rust runtime
(`crates/rustra/src/error.rs`) can put on the wire. Other documents keep partial
subsets on purpose (`docs/rust-api-guide.md` lists the Rust-factory codes only,
`docs/architecture.md` covers `registry.*`); this page is the full table and records
where each code actually comes from.

Counts today: **27 codes** in `RustraErrorCode`. 9 have a dedicated factory in
`error.rs`; 5 more are Rust-emitted from other files (or are shared fallbacks); 13
exist only on the JS/adapter side. The provenance of every code is marked below —
nothing is silently one-sided.

## How an error reaches JS

- Wire shape: `{ code, message, retryable? }` on structured frame/JSON paths. The Rust
  `Display` format is `"{code}: {message}"`.
- JS surface: every wire error becomes a `RustraCommandError` (`.code`, `.message`,
  `.retryable`). Two codes have dedicated subclasses so callers branch with
  `instanceof` instead of string comparison:
  - `transport.timeout` → `TimeoutError`
  - `cancelled` → `CancelledError`

  `normalizeRustraError` promotes structured rejects to these subclasses automatically.

- JSON fallback path: `parseRustraErrorString` splits a flattened
  `"{code}: {message}"` string only when the token before `": "` matches the code
  token pattern `^[a-z][a-z0-9_.]*$`. Anything else (FFI-level text such as
  `"json decode failed: ..."`) collapses to `invoke.failed` with the full string as
  the message. Rust enforces the same pattern at declaration time —
  `validate_error_code` panics on malformed codes.
- Custom domain errors: `RustraError::custom(code, message)` accepts any code string;
  domain codes declared through `CommandErrorVariant` flow into `schema.json` and the
  TS codegen. Those per-domain codes are contracts of individual commands, not part
  of the registry below.

## Code table

| Code                         | Meaning                                                                                                                                         | Typical producer                                                                                                      | Provenance                           | Retryable |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------- |
| `command.not_found`          | Invoked command is not in the registry                                                                                                          | Rust runtime (`RustraError::command_not_found`); JS adapters reuse it for missing generated commands                  | Both — `error.rs` factory            | no        |
| `command.invalid_args`       | Argument deserialization or validation failed                                                                                                   | Rust runtime (`RustraError::invalid_args`)                                                                            | Both — `error.rs` factory            | no        |
| `capability.denied`          | Required capability not granted (deny-by-default) — the handler never runs                                                                      | Rust Runtime Authority (`RustraError::capability_denied`)                                                             | Both — `error.rs` factory            | no        |
| `platform.unavailable`       | Platform-specific command exists in the contract but has no implementation on the current platform                                              | Rust runtime (`RustraError::platform_unavailable`) — distinct from `command.not_found`                                | Both — `error.rs` factory            | no        |
| `sync.unavailable`           | Synchronous invoke unsupported — native exposes no typed fast path, or rejects sync metadata                                                    | JS adapters (`frame-engine-sync.ts`, `global-sync.ts`)                                                                | JS/adapter only                      | no        |
| `payload.too_large`          | Payload exceeds the size limit (default 1 MiB)                                                                                                  | Rust FFI (`RustraError::payload_too_large`) and the JS pre-check (`maxPayloadBytes`) — same code on every path        | Both — `error.rs` factory            | no        |
| `transport.error`            | Transient transport failure                                                                                                                     | Host transport adapters; Rust factory `RustraError::transport`                                                        | Both — `error.rs` factory            | yes       |
| `transport.unavailable`      | Host auto-detection found no executable native transport                                                                                        | JS adapters (`bun-ffi.ts`, `node-bootstrap.ts`, `react/context.ts`)                                                   | JS/adapter only                      | no        |
| `transport.timeout`          | Timeout race expired — `instanceof TimeoutError` in TS                                                                                          | Transport timeout race (JS `timeoutMs`); Rust factory `RustraError::timeout`                                          | Both — `error.rs` factory            | yes       |
| `cancelled`                  | Cooperative cancellation (`AbortSignal`/`cancel`) — `instanceof CancelledError` in TS                                                           | Rust factory `RustraError::cancelled`; JS cancel path                                                                 | Both — `error.rs` factory            | yes       |
| `internal`                   | Rust internal failure (serialization, I/O, panic normalization)                                                                                 | Rust (`RustraError::internal`, `From<std::io::Error>`)                                                                | Both — `error.rs` factory            | no        |
| `registry.frozen`            | Structural mutation of a frozen registry rejected                                                                                               | Rust registry (`registry.rs`, via `RustraError::custom`)                                                              | Rust runtime — no `error.rs` factory | no        |
| `registry.id_exhausted`      | `command_id` u16 space exhausted (max 65534)                                                                                                    | Rust registry (`registry.rs`, via `RustraError::custom`)                                                              | Rust runtime — no `error.rs` factory | no        |
| `ffi.not_registered`         | Global FFI package not registered before the call                                                                                               | Rust FFI entries (`ffi_typed_entries.rs`, `ffi_typed_buffer.rs`, `ffi_hot_reload.rs`)                                 | Rust runtime — no `error.rs` factory | no        |
| `invoke.failed`              | Generic invoke failure — the fallback code                                                                                                      | JS `parseRustraErrorString` for non-code-token strings; Rust fallbacks (`hot_core_dylib.rs`, `ffi_schema_entries.rs`) | Both — fallback, no factory          | no        |
| `invoke.malformed`           | Wire frame parsing failed                                                                                                                       | JS codec layer (`complex-codec.ts`, `json-wire.ts`)                                                                   | JS/adapter only                      | no        |
| `invoke.too_short`           | Payload shorter than the frame header                                                                                                           | JS codec layer (complex codecs, generated postcard codecs)                                                            | JS/adapter only                      | no        |
| `schema.unavailable`         | Schema lookup failed                                                                                                                            | JS adapter (`live-schema.ts`)                                                                                         | JS/adapter only                      | no        |
| `event.unavailable`          | Events undeliverable — no `drainEvents`/`onPushEvent` pair, invalid poll-interval env, or RN module without `onEvent`                           | JS adapters (`node-events.ts`, `react-native-events.ts`)                                                              | JS/adapter only                      | no        |
| `channel.unavailable`        | Channel cannot be issued or released                                                                                                            | JS adapters (`react-native-events.ts`, `tauri-channels.ts`)                                                           | JS/adapter only                      | no        |
| `device.unavailable`         | Device capability missing / OS switch off — a different axis from `platform.unavailable` (no implementation) and `capability.denied` (no grant) | Host app / derived providers (rustra core does no device gating)                                                      | JS/adapter only                      | no        |
| `device.permission_denied`   | Device capability use denied by user or policy                                                                                                  | Host app / derived providers                                                                                          | JS/adapter only                      | no        |
| `contract.mismatch`          | Contract hash mismatch (JS newer than native)                                                                                                   | Contract gate (`frame-engine-contract.ts`, node/bun bootstrap)                                                        | JS/adapter only                      | no        |
| `contract.unenforceable`     | Contract hash cannot be verified (native lacks support)                                                                                         | Contract gate (`frame-engine-contract.ts`, node/bun bootstrap)                                                        | JS/adapter only                      | no        |
| `inspector.invalid_snapshot` | Inspector snapshot JSON truncated or unparseable (experimental)                                                                                 | TS inspector decoder — loud-fail contract                                                                             | JS/adapter only                      | no        |
| `inspector.unexpected_shape` | Snapshot JSON is valid but has an unexpected shape (experimental)                                                                               | TS inspector decoder                                                                                                  | JS/adapter only                      | no        |
| `unknown`                    | Unclassifiable error — last-resort fallback                                                                                                     | JS `normalizeRustraError` for opaque transport strings; Rust hot-core/Tauri error-JSON fallback                       | Both — fallback, no factory          | no        |

## Provenance summary

- **Rust factory in `error.rs` (9):** `command.not_found`, `command.invalid_args`,
  `capability.denied`, `platform.unavailable`, `payload.too_large`, `transport.error`,
  `transport.timeout`, `cancelled`, `internal`.
- **Rust-emitted without an `error.rs` factory (3):** `registry.frozen`,
  `registry.id_exhausted` (`registry.rs`), `ffi.not_registered` (FFI entries).
- **Shared fallback codes without a factory (2):** `invoke.failed`, `unknown` — both
  sides emit them as last-resort values.
- **JS/adapter-side only (13):** `sync.unavailable`, `transport.unavailable`,
  `invoke.malformed`, `invoke.too_short`, `schema.unavailable`, `event.unavailable`,
  `channel.unavailable`, `device.unavailable`, `device.permission_denied`,
  `contract.mismatch`, `contract.unenforceable`, `inspector.invalid_snapshot`,
  `inspector.unexpected_shape`.

## Retryability

- Rust: the `transport`, `timeout` and `cancelled` factories construct with
  `retryable: true`; every other factory constructs with `false`. Any instance can be
  marked with the `.retryable()` builder, and `custom(...)` defaults to `false`. On the
  wire the flag is omitted when `false`.
- TS: when the structured wire carries the flag it wins; when it is absent (flagless
  JSON paths), `isRetryableCode` infers it for exactly `transport.error`,
  `transport.timeout` and `cancelled` — mirroring the Rust factory convention.
- `CommandErrorVariant::retryable` is codegen documentation metadata only; runtime
  retryable is still derived from the instance's code/flag.
- `retryable: true` does not mean "safe to re-run" — do not blindly retry
  non-idempotent commands.

## Sync gate and known gaps

`packages/types/src/error-codes-sync.test.ts` keeps the two sides honest: every
`error.rs` factory code must exist in `RustraErrorCode` (failures list the missing
codes), every TS code must be either an `error.rs` factory code or explicitly declared
in the test's out-of-scope manifest with a reason, and stale manifest entries fail in
both directions.

The gate scans `error.rs` only, so Rust-emitted codes living elsewhere are outside it.
Two are known today and intentionally have no `RustraErrorCode` constant:
`signature.mismatch` (`registry.rs` `replace()` wire-signature guard) and
`invoke.backpressure` (async FFI worker queue full — delivered as a Display string and
re-split into a code by `parseRustraErrorString`; its message says "retry after drain"
but it carries no `retryable` flag). Adding constants for them is a deliberate
follow-up, not something this page assumes.
