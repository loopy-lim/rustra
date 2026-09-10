[한국어](./dev-tier.ko.md)

# Dynamic Development Tier (Dev Tier)

rustra contracts freeze at release time — schema.json, the generated client, and
the device capability catalog are all closed sets. **During development those
walls can stay open.** This guide covers the four mechanisms behind "dynamic in
dev, static in release" and when to promote dynamic experiments into the static
contract.

| Mechanism                                                                      | During development                 | Release wall                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| [`invokeLoose`](#invokeloose-command-prototyping) — name-based loose invoke    | call any command by string key     | promote hot commands via `rustra codegen` (Tier 3 JSON cost)              |
| Runtime command registration — `Package::register` (debug builds)              | register Rust handlers on the spot | release builds freeze — rewrite declaratively                             |
| [Device token experiments](#device-token-experiments) — catalog-outside tokens | debug builds warn and accept       | release builds panic at registration + `rustra doctor` fail (double wall) |
| [`test:fast`](#gate-profiles) — fast verification loop                         | compile parity + codegen units     | full battery stays in CI/PR                                               |

## invokeLoose command prototyping

The official surface for calling commands by name without waiting for the
generated client (`commands.ts` typed functions). It is not a new mechanism —
it is a named entry point over the engine's name-based `invoke`, which already
resolves static codec fast-path → live schema commandId lookup → Tier 3 (JSON)
fallback.

```ts
import { invokeLoose } from '@rustra/types';

// The result type defaults to unknown — callers narrow it.
const info = await invokeLoose<{ os: string }>(engine, 'platformNativeInfo');
```

The prototyping loop:

1. **Add the Rust handler** — via the macro (`#[command]`) or debug-build
   runtime registration (`Package::register`, string keys).
2. **`cargo build`** — that is the entire Rust side.
3. **Call `invokeLoose(engine, 'myCommand', args)` from JS immediately** — no
   codegen, no tsc, no api-surface update. The live schema provides the
   commandId; commands without a registry codec route through Tier 3 JSON.

When to promote — once a command's input/output types stabilize and its call
frequency grows, run `rustra codegen` as usual and move to the typed client.
The Tier 3 JSON fallback pays a JSON serialization cost, so high-frequency or
large-payload commands belong on the static path (see [benchmarks](benchmarks.md)).

## Device token experiments

The device capability catalog (`DeviceCapability::ALL`, 21 tokens) is a
versioned closed set. To experiment before a token lands in a rustra release:

1. **Declare in a debug build** — using a catalog-outside token such as
   `#[command(device("nfc-legacy-reader"))]` prints a warning and is accepted in
   debug builds. The declaration flows into the schema.json `devices` array.
2. **Codegen renders it with a marker** — the generated `devices.ts` union and
   constants include the unknown token, and the file carries a
   "catalog-outside tokens" marker comment below the union.
3. **The release wall is double** — the `rustra doctor` `codegen.device_catalog`
   check reports unknown tokens as **fail**, and release builds panic at
   registration. To ship, either rename to a catalog token or wait for a rustra
   release that extends the catalog (updating the
   [platform permissions cross-table](platform-permissions.md) alongside).

The catalog itself is single-sourced through the schema.json top-level
`deviceCapabilities` field — the CLI reads it for ordering and validation, so no
manual mirror exists.

## Gate profiles

| Stage    | What runs                                        | Command                                   |
| -------- | ------------------------------------------------ | ----------------------------------------- |
| Dev loop | cargo check + calculator tsc + cli units         | `bun run test:fast`                       |
| Commit   | eslint/prettier/rustfmt (staged only)            | lefthook pre-commit, automatic            |
| PR/CI    | full 10-job battery + docs·codegen checks        | `scripts/ci-gate.sh`                      |
| Release  | release-coherence·package verification·changeset | [release procedure](release-procedure.md) |

For Rust behavior during development, run `cargo test -p rustra <filter>` ad hoc
as needed. Drift (codegen checks, docs regions) is caught by the full battery —
there is no reason to repeat the ceremony inside the dev loop.

## Out of scope

- **Native hot-core** — the native (non-wasm) dev path is a separate
  experimental mechanism: `rustra dev` builds the core as a cdylib and a
  running host swaps it without restart
  ([hot-core design](plans/2026-09-09-native-hot-core-design.md),
  [glossary](glossary.md)).
- **`rustra codegen --from-live`** — promotion scaffolding that derives
  `#[command]` skeletons from a live registry dump is a follow-up slice (design:
  [dev-tier design](plans/2026-09-08-dev-tier-design.md) §G).
- **RN bundle subset** (`registry.commands`) — a separate track in the same
  Tier 3 direction (see the
  [A13 design](plans/2026-09-08-a13-rn-registry-subset-design.md)).
