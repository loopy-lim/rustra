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

Behavior-preserving cleanup pass: shared helpers replace duplicated logic
across packages and crates.

**`@rustra/types`** adds public `compareUtf8` (UTF-8 byte-order comparison used
by CLI codec keys and wire sorting), `abortedBeforeDispatch` (canonical
abort-before-dispatch error factory shared by invoke wrappers), `SubscriberMap`,
`createPollingEventDistributor`, and the `PollingEventDistributor` /
`PollingEventSource` types — the polling event loop core now lives in one place
(`@rustra/bun` and `@rustra/node` both delegate to it). The complex-codec
`Writer` writes into a single growable scratch buffer instead of concatenating
parts, `raw()`/`decString` return subarray views instead of copies, and the
debug wire hex preview is gated on the trace flag before formatting.

**`@rustra/node`** wraps binary requests instead of copying and scans NDJSON
lines with a consumed offset instead of repeated slicing; the loop handshake
learns the peer's `drainEvents` command id with a legacy fallback.

**Rust:** the serde struct/variant serializers share one core, `register!`/
`build!` share one command-chain builder, the wire `Writer` gains a recycled
constructor for scratch reuse, and the command function-name rule moved to
`rustra-naming::identifier_to_lower_camel`.

No wire-format or error-message changes.
