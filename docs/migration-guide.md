English | [한국어](./migration-guide.ko.md)

# Contract Migration Guide

When the contract (schema) shared by the Rust backend and TypeScript clients changes over time, this guide describes how to roll out breaking changes safely.

## Tools

### `rustra diff`

Compares two schema versions and detects breaking changes. It returns exit 1 when there is a breaking change so it can be used as a CI gate.

```bash
# text output
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json

# machine-readable (DiffResult JSON)
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json --format json
```

### The 4 detected breaking change types

| Type                    | Meaning                  |
| ----------------------- | ------------------------ |
| `command_removed`       | Command deleted          |
| `field_removed`         | input/output field deleted |
| `field_type_changed`    | Field type changed       |
| `required_field_added`  | Required field newly added |

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

`GENERATED_CONTRACT_HASH` in `contract.ts` is the SHA-256 of the entire schema. When the schema changes, the hash changes. Passing the `contractHash` option to `createRkyvV2Engine` compares against the native hash at runtime and fails immediately on mismatch (fail-fast).

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
