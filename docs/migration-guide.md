English | [한국어](./migration-guide.ko.md)

# Contract Migration Guide

When the contract (schema) shared by the Rust backend and TypeScript clients changes over time, this guide describes how to roll out breaking changes safely.

## Where to start (by your rustra version)

- **From 0.3.x** — follow [migrating from 0.3 to 0.4](migrations/0.3-to-0.4.md) first, then use this guide.
- **From 0.5.x** — follow [migrating from 0.5 to 0.6](migrations/0.5-to-0.6.md) first. Old schemas may also fail CLI validation with a "generic type name" error (see the [Rust API guide — user-defined generics](rust-api-guide.md#user-defined-generic-types)); rebuild `schema.json` with the current rustra before running `rustra diff`.
- **0.6 and later (incl. 0.8)** — no migration note needed; the recipes below apply directly.
- **0.9-series rename (rkyv V2 → Frame)** — see [the rename table](#09-rename-rkyv-v2--frame) below; a pure rename, the wire format is unchanged.

## 0.9 rename: rkyv V2 → Frame

The 0.9 series renames the binary protocol formerly called "rkyv V2" to
**Frame** across all APIs. This is a naming change only — the wire bytes,
framing, and postcard payload codec are unchanged, so old and new builds stay
interoperable. Update the identifiers you reference:

| Old (≤0.8)                             | New (0.9+)                           |
| -------------------------------------- | ------------------------------------ |
| `createRkyvV2Engine`                   | `createFrameEngine`                  |
| `RkyvV2Engine`                         | `FrameEngine`                        |
| `RkyvV2Codec`                          | `FrameCodec`                         |
| `RkyvV2Native`                         | `FrameNative`                        |
| `invokeRkyvV2`                         | `invokeFrame`                        |
| `rkyv-codecs.ts`                       | `frame-codecs.ts`                    |
| `rkyv-registry.ts`                     | `frame-registry.ts`                  |
| `rkyv-engine`                          | `frame-engine`                       |
| `rustra_ffi_invoke_rkyv_v2*`           | `rustra_ffi_invoke_frame*`           |
| `BUN_RKYV_V2_ENGINE_SUPPORTS`          | `BUN_FRAME_ENGINE_SUPPORTS`          |
| `REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS` | `REACT_NATIVE_FRAME_ENGINE_SUPPORTS` |
| error prefix `"rkyv v2: ..."`          | `"frame: ..."`                       |

The RN JSI host method follows the same rename (`invokeRkyvV2` → `invokeFrame`),
and codegen output files land under the new names (`frame-codecs.ts`,
`frame-registry.ts`) — re-run `rustra codegen` and update imports.

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

### field_removed — field deletion

Instead of deleting, a **two-step deprecated transition** is recommended:

```rust
// Step 1: keep the field as Option and give clients time to migrate
pub struct UserOutput {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>, // deprecated — use name
}

// Step 2 (next release): remove the field — diff then reports field_removed
```

If you must delete immediately, regenerate the TS clients first to remove references to the field, then deploy the Rust side.

### field_type_changed — type change

A two-step transition with an intermediate new field:

```rust
// before
pub struct Config { pub timeout: i64 }

// Step 1: add the new field + deprecate the existing field
pub struct Config {
    #[serde(default)]
    pub timeout_ms: i64,           // new
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<i64>,      // deprecated (in seconds)
}

// Step 2: remove the old field
```

### required_field_added — adding a required field

Starting with `Option<T>` + `#[serde(default)]` is not breaking:

```rust
pub struct SearchInput {
    pub query: String,
    #[serde(default)]                    // has a default → not required
    pub limit: Option<i64>,              // OK even if clients omit it
}
```

If the semantics must be required, deploy with a default value first and then remove the default in the next version — two steps.

### command_removed — command deletion

Backward compatibility can be kept with an alias:

```rust
#[command(name = "oldName")]
fn new_name(input: NewInput) -> Result<NewOutput> { /* ... */ }
```

Add the command under a new name and keep the old name as an alias; once clients have migrated naturally, remove the alias.

## Rollout order and contract hash

`GENERATED_CONTRACT_HASH` in `contract.ts` is the SHA-256 of the entire schema. When the schema changes, the hash changes. Passing the `contractHash` option to `createFrameEngine` compares against the native hash at runtime and fails immediately on mismatch (fail-fast).

**Safe deployment order (default):**

1. Deploy the Rust backend — **additive changes** are compatible with existing clients.
   (the state where `rustra diff` reports 0 breaking changes)
2. Regenerate the TS clients (`bun run codegen`) and deploy.

**When a breaking change is unavoidable (the reverse is impossible — always ship the new client first):**

1. Deploy Rust that accepts the new schema while also accepting old-schema requests
   (the `#[serde(default)]` pattern from the recipes above serves this role).
2. Regenerate and deploy the TS clients.
3. Deploy Rust with the old fields/commands removed (`field_removed` then occurs intentionally).

> In environments with contractHash verification enabled, a hash mismatch error
> (`contract.mismatch`) can occur between steps 1→2, so turn verification off
> during the migration window or update the hash in step 2.

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

- `diffSchemas` compares only top-level `properties` — changes inside nested
  `$ref` definitions are not detected (improvement candidate).
- The `compatible[]` list reports new command/optional field additions.
