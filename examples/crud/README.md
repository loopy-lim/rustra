English | [한국어](./README.ko.md)

# CRUD Example

A full CRUD (Create, Read, Update, Delete) pattern example using rustra-bridge.

## Commands

| Command      | Input                   | Output        |
| ------------ | ----------------------- | ------------- |
| `createItem` | `{ name, value }`       | `{ item }`    |
| `getItem`    | `{ id }`                | `{ item }`    |
| `listItems`  | `{ minValue? }`         | `{ items }`   |
| `updateItem` | `{ id, name?, value? }` | `{ item }`    |
| `deleteItem` | `{ id }`                | `{ deleted }` |

## Build

```sh
cargo build -p rustra-crud-example
```

## TypeScript Code Generation

```sh
bun run --cwd examples/crud codegen   # Rust schema probe + TS render + host entry in one shot
# or from this directory: bun run codegen
```

Generated into `examples/crud/generated/`:

- `schema.json` — JSON Schema for all commands (published by the Rust probe)
- `types.ts` — TypeScript type definitions (rendered by `rustra codegen`)
- `commands.ts` — type-safe command helper functions
- `contract.ts` — contract hash for compatibility checks
- `node.ts` — generated Node host entry (bootstrap + engine setup), enabled by the `node` key in `rustra.json`

## Tests

```sh
bunx tsc -p examples/crud/tsconfig.json
node --test dist-ts/examples/crud/ts/crud-operations.test.js
```

## Usage from TypeScript

The `node` host in `rustra.json` generates `node.ts`, which bootstraps the
engine (strict contract verification, release/debug binary candidate
resolution) and installs it lazily — generated commands take a single input
object and no engine parameter, exactly like the calculator example:

```ts
import { createItem, rustra } from './generated/node.js';

const { item } = await createItem({ name: 'Widget', value: 42 });
console.log(item.id, item.name, item.value);

rustra.dispose(); // engine subprocess teardown
```

Prerequisite: `cargo build -p rustra-crud-example` — the entry resolves
`target/release/` first, then `target/debug/`.

**Transport caveat (one-shot):** the generated Node entry spawns the stdio
binary once per invoke, so every call runs in its own process — this example's
in-memory Rust store does not carry across calls on this transport. The full
stateful `create → get → update → delete` flow runs in one process via the Rust
demo (`cargo run -p rustra-crud-example --bin rustra-crud-example`) and against a stateful
mock engine in
[`ts/crud-operations.test.ts`](ts/crud-operations.test.ts); for a persistent
process see the calculator's loop transport
([`node-performance.ts`](../calculator/apps/node-performance.ts)).
