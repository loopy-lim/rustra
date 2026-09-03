English | [한국어](./versioning-policy.ko.md)

# Versioning and Compatibility Policy

This document defines what each version bump promises, how items are
deprecated, and which surfaces are exempt from stability guarantees. It is the
reference for CI gates and for the experimental surface listed below. Release
mechanics (who publishes what, in which order) live in the
[release procedure](release-procedure.md); schema-level breaking-change
detection lives in the [contract migration guide](migration-guide.md).

## Scope of compatibility guarantees

| Surface                                                      | Guarantee within a minor release                                                                   | Breaking change requires                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire format (rkyv V2 / postcard bytes for a released schema) | Stable once a schema is released: bytes produced for a given schema + contract hash keep decoding. | Major version. Pre-1.0: a minor with explicit migration notes.                                                                                                                                    |
| Contract hash algorithm                                      | Compatibility-critical: the hash-of-schema input definition is frozen per release.                 | Major version. Pre-1.0: a minor with explicit migration notes.                                                                                                                                    |
| FFI symbol signatures (`rustra_ffi_*` C ABI)                 | Additive only. Existing symbols keep name, parameter list, and calling convention.                 | Removals and signature changes go through the deprecation cycle below, then a major. Pre-1.0: the deprecation rule applies — a symbol deprecated in a previous release may be removed in a minor. |
| Generated output (TypeScript / C++ / RN generated files)     | Regenerated output stays drop-in for the same configuration.                                       | Major version. Pre-1.0: a minor with explicit migration notes.                                                                                                                                    |
| Public Rust API (`crates/rustra`, `rustra-macros` exports)   | Standard semver.                                                                                   | Major version. Pre-1.0: a minor with explicit migration notes.                                                                                                                                    |
| Public TypeScript API (`@rustra/*` package exports)          | Standard semver.                                                                                   | Major version. Pre-1.0: a minor with explicit migration notes.                                                                                                                                    |

Not covered by any guarantee:

- Internal modules, including everything under `crates/rustra/src/__private`.
- `#[doc(hidden)]` Rust items and `@internal`-tagged TypeScript items.
- Anything reachable only through the surfaces above.

## Deprecation procedure

1. Mark it. Rust items get `#[deprecated]` with a note pointing at the
   replacement; TypeScript items get JSDoc `@deprecated`. `#[doc(hidden)]` may
   accompany the attribute but does not replace it.
2. Announce it. The release notes of the deprecating version list the item and
   the replacement.
3. Keep it. A deprecated item remains for at least 1 minor release.

Pre-1.0 rule: removal is allowed in a minor release if the item was deprecated
in a previous release, and the removal is documented in the CHANGELOG and —
where consumers must act — in `docs/migrations/<from>-to-<to>.md`.

Per-version migration notes live in
[`docs/migrations/`](migrations/) — see
[0.3 to 0.4](migrations/0.3-to-0.4.md) and
[0.5 to 0.6](migrations/0.5-to-0.6.md).

Recent removal: `RendererHost` (with `HostMessage`, `MessageKind`,
`RendererCapabilities`, `Size`, `SurfaceOptions`, `host_supports_eval`) was
deprecated through 0.6.0 and removed in 0.7.0 under the pre-1.0 rule above.
The replacement is a host-specific adapter boundary — each embedding host
bridges its own renderer/events via the published channel and FFI surfaces.

## Experimental surface

Experimental items may change or break in any release until they stabilize.
Marking is explicit: a doc comment containing "experimental" plus an entry in
the table below. An item leaves this table only by entering the guarantees
above; any later change then follows the deprecation procedure.

| Item                          | Status       | Notes                                                                                                                                                                                   |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rustra_ffi_hot_reload`       | Experimental | Landed this cycle. Hot-reload injection with replace semantics; the skip report and error ladder may still change between releases.                                                     |
| `rustra_ffi_capture_snapshot` | Experimental | B1 inspector dump. Shape changes are breaking, except additive fields, which are backward-compatible.                                                                                   |
| `@rustra/types` inspector     | Experimental | `DumpedWire` + `parseSnapshot`/`serializeSnapshot` mirror the blob contract above (additive fields allowed). `rustra inspect` renders this experimental format and inherits its status. |

## MSRV policy

The workspace MSRV is Rust 1.88: the root `Cargo.toml` sets
`rust-version = "1.88"` and member crates inherit it via
`rust-version.workspace = true`. The pin reflects edition 2024 (1.85) plus
let-chains (1.88, used in `rustra-macros`).

MSRV bumps happen only in minor releases, never in patch releases. A bump is a
minor-release change even though it touches no API, because it can break
consumer toolchains.

## Release numbering

The project is on 0.x. Versions of the 9 public `@rustra/*` npm packages are
driven by changesets: when changeset files exist on main, `release.yml` opens
the version-packages PR (`chore: version packages`), and merging it updates version fields and
CHANGELOGs in bulk. crates.io publishing is manual — `cargo publish` per
crate, in the order given by the
[release procedure](release-procedure.md) — and published versions cannot be
deleted or replaced.

Until 1.0, a breaking change on any guaranteed surface above — including the
public Rust and TypeScript APIs — ships as a minor version with explicit
migration notes (documented in CHANGELOG and, where consumers must act, in
`docs/migrations/<from>-to-<to>.md`). From 1.0 this allowance is gone: such
changes require a major version. The project stays on minor releases until
then; majors are not issued pre-1.0.
