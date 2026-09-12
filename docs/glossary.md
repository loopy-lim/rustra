[한국어](./glossary.ko.md)

# Glossary

Definitional reference for terms that are overloaded inside rustra or easily
confused with same-named things outside it. Each entry states what the term
**is**, the **canonical spelling**, and where the authoritative document lives.
This page does not track history — for decisions and timelines, follow the
linked documents.

Spelling policy: technical identifiers (crate names, cargo features, module and
symbol names, config keys, flags) are kept in Latin script in both languages.
In Korean prose, a descriptive gloss such as 핫코어/핫스왑 may accompany the
identifier, but the identifier itself (`hot-core`, `parity gate`, `contract
hash`) is not transliterated.

| Term                    | In one line                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Frame                   | Rustra's binary frame protocol — V2 framing + command ids + postcard payload codec (formerly "rkyv V2") |
| postcard                | the actual payload codec (serde-compatible compact format)                                              |
| Tier 1 / 2 / 3          | wire codec tiers: static postcard / complex schema / JSON-in-binary fallback                            |
| dev tier                | "dynamic in dev, static in release" development mechanisms — unrelated to wire tiers                    |
| hot-core                | native dylib hot-swap dev mechanism (experimental)                                                      |
| `rustra_ffi_hot_reload` | the older hot-* mechanism: replace-semantics reload injection                                           |
| parity gate             | `rustra dev` rebuild gate comparing the contract hash before announcing a reload                        |
| contract hash           | SHA-256 of the schema JSON only                                                                         |
| dylib / cdylib          | Rust dynamic-library crate-type — the hot-swap unit                                                     |
| channel family          | `ChannelHandle` + the four per-host binary-channel factories                                            |
| host                    | four senses: embedding app / `ChannelHost` / JSI host object / host promotions                          |
| snapshot                | four senses: API snapshot / inspector dump / debug-log value / changeset canary                         |
| gate (standalone)       | overloaded: profiles, capability, drift, release, acceptance, api-surface, scripts                      |
| codec / Codec IR        | payload serializer / the shared schema IR behind complex codecs                                         |
| mirror                  | three senses: en/ko document pair / hand-maintained duplicate / verb "to mirror"                        |
| subsecond               | dioxus hot-reload tech — evaluated and deferred; not part of the architecture                           |

## Frame

**Frame** is the name of Rustra's binary frame protocol (V2 framing + command
ids + postcard payload codec); it was formerly named "rkyv V2". The payload
codec is postcard, not the upstream `rkyv` crate — that crate is absent from
`Cargo.lock`. Canonical wire shape — request `[cmd_id u16 LE][postcard body]`,
response `[ok u8][pad][...]` with a path-specific body, error frame
`[ok=0][pad][err_len u16 LE][postcard {code, message}]`. The wire-level
authority is the "Names" table in [wire-format.md](wire-format.md). Generated
artifacts and symbols carry the Frame name (`frame-codecs.ts`, `invokeFrame`).

## postcard

The payload serializer actually used on the manifest/dispatch paths
(`postcard` dependency in `crates/rustra/Cargo.toml`). A serde-compatible
compact binary format. When a document says a command is "postcard-encoded",
that is the concrete codec behind a Frame.

## Tier 1 / Tier 2 / Tier 3 (wire codec tiers)

The three wire codec routes a command's payload can take inside a Frame:

- **Tier 1** — static postcard: schema-known simple fields, encoded postcard.
- **Tier 2** — complex schema: recursive map/enum/Option/Set/BigInt shapes via
  the schema-driven complex codec.
- **Tier 3** — JSON-in-binary fallback: `[cmd_id u16 LE][JSON]`, for schemas
  neither binary codec supports. Implementation: `crates/rustra/src/frame_tier3.rs`.

See [architecture.md](architecture.md) ("Invocation Path for Dynamic
Commands") and [complex-codecs.md](complex-codecs.md).

## dev tier

The **dynamic development tier** — the "dynamic in dev, static in release"
mechanisms (`invokeLoose`, debug runtime registration, catalog-outside device
tokens, `test:fast`). Documented in [dev-tier.md](dev-tier.md).

Warning: the word **tier** here is unrelated to the wire codec tiers above.
"Dev tier" is about when the contract is open or frozen; "Tier 1/2/3" is about
which codec encodes a payload on the wire.

## hot-core

The native dylib hot-swap development mechanism: the Rust core is built as a
cdylib and swapped into a running host without restart. Consists of the
`hot-core` cargo feature, the `DylibCore`/`HotCoreHandle` primitives, the
sha256 poll watcher, and the `RUSTRA_HOT_CORE` environment variable pointing
the host at the artifact (the React Native adapter instead polls a directory
named by `RUSTRA_HOT_CORE_DIR` — a file path and a directory are two different
variables). **Experimental** (see the experimental-surface table in
[versioning-policy.md](versioning-policy.md)). Design and status:
[plans/2026-09-09-native-hot-core-design.md](plans/2026-09-09-native-hot-core-design.md).

Canonical spelling: `hot-core` in both languages. In Korean prose, concept
descriptions may additionally use 핫코어/핫스왑 as a gloss, but the feature,
module, and flag spellings stay `hot-core` / `RUSTRA_HOT_CORE`.

## `rustra_ffi_hot_reload` vs hot-core

Two different hot-* mechanisms that must not be conflated:

- **`rustra_ffi_hot_reload`** — the older mechanism: reload **injection** with
  replace semantics (an FFI entry a host calls to reset engine state in
  process). Experimental per [versioning-policy.md](versioning-policy.md).
- **hot-core** — the newer mechanism: native **dylib swap** (dlopen of a
  rebuilt cdylib via `DylibCore`, see above). The core code itself is replaced,
  not reset.

Rule of thumb: hot_reload replaces state, hot-core replaces the library.

## parity gate

The `rustra dev` rebuild gate: before announcing a reload, the CLI compares the
contract hash captured before codegen against the one after; on mismatch the
reload is not announced at all (fail-closed — the host keeps the old engine).
Config keys `dev.wasm.parityGate` / `dev.dylib.parityGate`, default `true`.
Korean documents render the name variously (parity 게이트, 정합 게이트, 정합성
게이트) — all refer to this same gate; this page maps them instead of forcing
one rendering.

## contract hash

The SHA-256 hash of the **schema JSON only** (`generated_contract_hash` in
`crates/rustra/src/package_schema.rs` — the same input as
`generate_typescript()`, without generation counters). It is the identity of
the contract used by `rustra diff`, the parity gate, and
`rustra_ffi_contract_hash`. Korean documents use contract hash, 계약 해시, and
컨트랙트 해시 interchangeably — same thing.

## dylib / cdylib

A Rust dynamic library: `crate-type = ["cdylib"]` (C ABI dynamic library) or
the general dylib notion. In rustra, the cdylib artifact is the **hot-swap
unit** of hot-core — `rustra dev` builds it (`dev.target: "dylib"`) and the
host dlopens the swapped-in copy. Release builds are unaffected: the static
linking path is unchanged.

## channel / ChannelHandle / binary channel

A channel is a unicast reply stream scoped to one invocation.
`ChannelHandle` is a `u32` newtype (`crates/rustra/src/channels_handles.rs`);
`ChannelHost` is the core-side sender registry (see **host** below). Binary
channels (raw byte frames instead of JSON strings) have per-host factory names
— this is by design, not an inconsistency. The canonical family:

| Host         | JSON channel             | Binary channel factory        |
| ------------ | ------------------------ | ----------------------------- |
| React Native | `createChannel`          | `createBytesChannel`          |
| Tauri (web)  | `createChannel`          | `createChannelBytes`          |
| Node         | `createNodeChannel`      | `createNodeBytesChannel`      |
| Bun          | `createBunChannelBridge` | `createBunChannelBytesBridge` |

See [events-and-channels.md](events-and-channels.md) (channels sections).

## host

Four senses, ranked by how often each appears:

1. **Embedding app / host adapter** (dominant) — the JS runtime embedding the
   Rust core (Node, Bun, Tauri, React Native), or the adapter package serving
   it. "Host-neutral", "host adapter", "per-host" all mean this.
2. **`ChannelHost`** — the Rust core-side channel/resource sender registry
   (`crates/rustra/src/channels_host.rs`). Nearly the **inverse** of sense 1:
   this host lives inside the core and hands handles out to the embedding app.
3. **JSI host object / host function** — the RN native side: the C++/TurboModule
   object exposing `invokeFrame` etc. to JavaScript.
4. **Host promotions** (host promotions / 호스트 승격) — the adapter-side error
   promotion points where a wire error becomes a thrown JS error (see
   [wire-format.md](wire-format.md)).

## snapshot

Four senses:

1. **api-surface snapshot** — `scripts/api-surface.mjs` and
   `api-surface/snapshot.json`, the public-API drift gate.
2. **`rustra_ffi_capture_snapshot`** — the B1 inspector wire dump (experimental
   surface, [versioning-policy.md](versioning-policy.md)), rendered by
   `rustra inspect`.
3. **Debug-log value snapshot** — the truncated `value` field in
   `RUSTRA_DEBUG` wire logs ([development-hurdles.md](development-hurdles.md)).
4. **`--snapshot canary`** — the changesets snapshot publish used in the
   release procedure's canary step ([release-procedure.md](release-procedure.md)).

## gate (standalone)

"Gate" is overloaded. Families:

- **Gate profiles** — the dev/commit/CI/release verification stages
  ([dev-tier.md](dev-tier.md)).
- **Capability gates** — deny-by-default `require_capability` + runtime grants;
  the binary-channel capability negotiation (`channelBytes`).
- **Drift gates** — CI checks that generated files/docs match their sources
  (codegen `--check`, the `docs:sync` regions).
- **Release-time gates** — release-coherence and package verification scripts.
- **Runtime acceptance gates** — the per-adapter stable-scope gates in
  [compatibility-contract.md](compatibility-contract.md).
- **api-surface snapshot gate** — sense 1 of snapshot above.
- **Script names** — `scripts/ci-gate.sh`, `scripts/docs-gate.mjs`,
  `scripts/onboarding-gate.mjs`.

## codec / Codec IR

**Codec** — a payload serializer/deserializer for command I/O (postcard codec,
complex codec, JSON codec, the generated TS/C++ codecs).
**Codec IR** — the shared schema intermediate representation the complex codecs
are compiled from; it decides what the TS and C++ generators can encode natively
([complex-codecs.md](complex-codecs.md),
[codegen.md](internal/codegen.md), `crates/rustra/src/complex_codec_schema.rs`).

## mirror

Three senses:

1. **Document mirror** — the en/ko pair convention: `*.md` plus `*.ko.md` kept
   tightly mirrored (see docs/README.md).
2. **Manual mirror / 수동 미러** — a hand-maintained duplicate of generated
   data inside a doc; rustra avoids these by single-sourcing (e.g. the device
   capability catalog has no manual mirror, [dev-tier.md](dev-tier.md)).
3. **Verb** — "X mirrors Y": one surface deliberately follows another's shape
   (e.g. the TS inspector types mirror the blob contract,
   [versioning-policy.md](versioning-policy.md)).

## subsecond

The dioxus subsecond hot-reload technology. Evaluated as an alternative for the
native hot-swap loop and **deferred/rejected for now** (Tauri lib+bin layout
patch bug dioxus#5778; re-evaluation is a Phase 4 item). Not part of the
architecture — see
[plans/2026-09-09-native-hot-core-design.md](plans/2026-09-09-native-hot-core-design.md)
(alternatives section).
