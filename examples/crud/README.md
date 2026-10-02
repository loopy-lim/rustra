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
import { createItem, getItem, rustra } from './generated/node.js';

const { item } = await createItem({ name: 'Widget', value: 42 });
console.log(item.id, item.name, item.value);
console.log((await getItem({ id: item.id })).item);

rustra.dispose(); // engine subprocess teardown
```

Prerequisite: `cargo build -p rustra-crud-example` — the entry resolves
`target/release/` first, then `target/debug/`.

`node.persistent: true` in this example's config keeps one Rust process alive
across commands, so the in-memory store survives `create → get → update → delete`.
The binary implements the NDJSON `serve` protocol. For a custom server flag,
set `node.args` explicitly. Call `rustra.dispose()` when the application closes.
Without this option, schemas without events retain the one-shot `invoke` protocol.

Run the actual generated Node consumer with `bun run test:runtime:crud` from
the repository root.
