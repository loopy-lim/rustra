English | [한국어](./migration-guide.ko.md)

# Contract Migration Guide

When the contract (schema) shared by the Rust backend and TypeScript clients changes over time, this guide describes how to roll out breaking changes safely.

## Where to start (by your rustra version)

- **From 0.3.x** — follow [migrating from 0.3 to 0.4](migrations/0.3-to-0.4.md) first, then use this guide.
- **From 0.5.x** — follow [migrating from 0.5 to 0.6](migrations/0.5-to-0.6.md) first. Old schemas may also fail CLI validation with a "generic type name" error (see the [Rust API guide — user-defined generics](rust-api-guide.md#user-defined-generic-types)); rebuild `schema.json` with the current rustra before running `rustra diff`.
- **From 0.6–0.9** — include the [Frame/API migration](migrations/post-0.9-frame-and-audit.md) when crossing the Rust 0.10 release boundary, then use the recipes below.
- **The rkyv V2 → Frame rename (0.10.0 release)** — see [the rename table](#frame-rename-rkyv-v2--frame) below; a pure rename, the wire format is unchanged.

<a id="09-rename-rkyv-v2--frame"></a>

## Frame rename: rkyv V2 → Frame

The 0.10.0 release (2026-09-12) renames the binary protocol formerly called
"rkyv V2" to **Frame** across all APIs. This is a naming change only — the wire
bytes, framing, and postcard payload codec are unchanged. API names and native
symbols do change: regenerate clients and rebuild native libraries/shells together
as described in the [release migration](migrations/post-0.9-frame-and-audit.md).
Package versions are independent, so the rename belongs to
the release, not to one version number: the Rust workspace and
`@rustra/types`/`@rustra/node`/`@rustra/bun`/`@rustra/cli` shipped it as 0.10.0,
while `@rustra/tauri` and `@rustra/react-native` carried the same rename in
their own 0.9.0 — a 0.9.x adapter version alone therefore does not mean
pre-rename. Update the identifiers you reference:

| Old (pre-rename)                       | New (rename release)                 |
| -------------------------------------- | ------------------------------------ |
| `createRkyvV2Engine`                   | `createFrameEngine`                  |
| `RkyvV2Engine`                         | `FrameEngine`                        |
| `RkyvV2Codec`                          | `FrameCodec`                         |
| `RkyvV2Native`                         | `FrameNative`                        |
| `RkyvV2SchemaNative`                   | `FrameSchemaNative`                  |
| `invokeRkyvV2`                         | `invokeFrame`                        |
| `rkyv-codecs.ts`                       | `frame-codecs.ts`                    |
| `rkyv-registry.ts`                     | `frame-registry.ts`                  |
| `rkyv-engine`                          | `frame-engine`                       |
| `rustra_ffi_invoke_rkyv_v2*`           | `rustra_ffi_invoke_frame*`           |
| `decode_rkyv_v2_response`              | `decode_frame_response`              |
| `encode_rkyv_v2_error`                 | `encode_frame_error`                 |
| `decode_rkyv_v2_error_parts`           | `decode_frame_error_parts`           |
| `BUN_RKYV_V2_ENGINE_SUPPORTS`          | `BUN_FRAME_ENGINE_SUPPORTS`          |
| `REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS` | `REACT_NATIVE_FRAME_ENGINE_SUPPORTS` |
| error prefix `"rkyv v2: ..."`          | `"frame: ..."`                       |
| debug transport literal `'rkyv'`       | `'frame'`                            |

The RN JSI host method follows the same rename (`invokeRkyvV2` → `invokeFrame`),
and codegen output files land under the new names (`frame-codecs.ts`,
`frame-registry.ts`) — re-run `rustra codegen` and update imports.

The next CLI patch in the current source removes obsolete generated files only
when their bytes match ownership hashes in the previous `.rustra-generated.json`.
Published CLI 0.11.3 does not include this fix: also check for leftover
`rkyv-codecs.ts`/`rkyv-registry.ts` when running the type checker. If an earlier
CLI already replaced the manifest, restore the pre-upgrade generated files and
manifest together before regenerating with the fixed CLI, or review and move the
remaining files manually. Edited files, symlinks, and unrecorded files are never
automatically removed. `codegen --check` reports legacy leftovers without deleting them.

In an RN monorepo, register the app and generated module in the existing root
workspaces. The fixed CLI reuses that root. If an earlier run added an unwanted
nested workspaces field to the app manifest, compare it with the original manifest
and remove the unintended change. The CLI does not delete user-defined workspace settings.

## Tools

### `rustra diff`

Compares two schema versions and detects breaking changes. It returns exit 1 when there is a breaking change so it can be used as a CI gate; exit 2 means the command itself was invoked wrong (for example a missing `--old`/`--new`), so a CI job can tell a misconfigured step from a real breaking change.

```bash
# text output
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json

# machine-readable — { "schemaVersion": 1, "breaking": [...], "clean": boolean }
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json --format json
```

### Detected breaking change types

| Type                    | Meaning                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command_removed`       | Command deleted                                                                                                                                                                                                                                              |
| `command_id_changed`    | The command's numeric id moved (`from` → `to`) — every by-id call diverges                                                                                                                                                                                   |
| `field_removed`         | input/output field deleted                                                                                                                                                                                                                                   |
| `field_type_changed`    | Field type changed (`from` → `to`)                                                                                                                                                                                                                           |
| `required_field_added`  | Required field newly added (the old payload never had it)                                                                                                                                                                                                    |
| `field_became_required` | An existing optional field became required                                                                                                                                                                                                                   |
| `field_became_optional` | An existing required field became optional                                                                                                                                                                                                                   |
| `definition_removed`    | A nested type definition (`definitions`/`$defs`) the schema referenced was removed                                                                                                                                                                           |
| `event_removed`         | Event deleted                                                                                                                                                                                                                                                |
| `event_payload_changed` | Event payload changed. Field-level findings inside a payload are folded into one entry each with `path`, `before`, `after` — `(absent)` → `(required)` for a newly required field, `(present)` → `(removed)`, `(optional)` → `(required)`, or the type names |

The recipes below cover the four command-side types you will meet most often; the event and definition entries follow the same rollout order (see [events-and-channels.md](events-and-channels.md) for the event contract).

## Recipes per breaking change

Frame/postcard encodes struct fields by position. Field order, integer signedness,
float width, enum ordinals, tuple positions and optional-field presence are part
of the wire contract. Adding `Option<T>` or `#[serde(default)]` does not make a
binary change backward-compatible. `skip_serializing_if` is not a migration
mechanism for positional binary payloads.

### Field removal, type changes and field additions

Keep the old command's input/output layout unchanged. Introduce a versioned
command with a separate ID and adapt its input to the shared domain logic.
Keep the old name and ID routed to the old layout until its consumers retire.
Reordering fields or enum variants needs the same treatment as a type change.
An optional field addition is also reported as a breaking wire change.

A JSON-only transport can sometimes accept omitted fields using `serde(default)`.
Prove that behavior with the exact old/new JSON consumers. It does not establish
compatibility for generated Frame, postcard or native typed calls.

### Command removal

Retain the existing command while adding the new one. A name alias alone does
not preserve numeric dispatch IDs or convert the previous wire layout. Verify
both the name route and ID route with the previous generated client.

## Rollout order and contract hash

`GENERATED_CONTRACT_HASH` identifies the generated contract. With `contractHash`
provided, `createFrameEngine` verifies the native hash; generated host entrypoints
configure this check. Keep strict verification during migration. `warn` and
`off` change enforcement, not compatibility, and cannot make old binary layouts
safe for a new decoder.

1. Preserve the previous JS/Rust lockfiles, generated files and native build.
2. Align CLI, runtime adapters and Rust dependencies using the
   [compatibility table](compatibility-matrix.md). Regenerate the contract and
   all bindings, then rebuild the app-specific native library and host shell.
3. Run `rustra diff`, `rustra doctor` and `rustra codegen --check`. Exercise first
   call, changed fields, declared errors, event subscribe/unsubscribe and disposal
   in the intended host. A clean diff alone is not runtime acceptance.
4. Ship JS, generated output and the matching native build as a set. For staged
   mixed-version deployments, first implement and test an explicit versioned
   contract negotiation/translation path; do not bypass a hash mismatch.
5. Roll back the complete saved set and repeat the same calls. Reverting only
   the JS dependency cannot restore native symbol or wire compatibility.

## CI integration

Whether a schema change is breaking is checked automatically in the PR:

```yaml
# add to .github/workflows/ci.yml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # rustra diff compares against the base commit
- uses: oven-sh/setup-bun@v2
- run: bun install -g @rustra/cli # or: bun add -d @rustra/cli + bunx --bun rustra
- name: Check schema compatibility
  run: |
    git diff --name-only ${{ github.event.before }} ${{ github.sha }} | grep -q schema.json \
      && rustra diff --old <(git show ${{ github.event.before }}:generated/schema.json) \
                     --new generated/schema.json
```

If a breaking change is detected, the job fails with exit 1. If the breaking change is intended, perform a two-step transition using the recipes in `docs/migration-guide.md` or approve it explicitly in review.

## Limitations

- The diff traverses nested references (including recursive schemas), unions,
  tuples and map values and checks positional wire facets conservatively.
  Some JSON-only changes may therefore be reported as breaking.
- It cannot prove behavioral compatibility, native ABI compatibility, or changes
  to custom serde implementations that are absent from the schema.
- Event additions appear in `compatible[]`; optional field additions do not.
  Matching package IDs, supported capabilities and the final native build still
  require runtime verification.
