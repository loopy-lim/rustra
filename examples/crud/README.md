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
cargo run -p rustra-crud-example --bin generate   # contract probe: schema.json
bun run codegen                                   # render TS surfaces from schema.json
```

Generated into `examples/crud/generated/`:

- `schema.json` — JSON Schema for all commands (published by the Rust probe)
- `types.ts` — TypeScript type definitions (rendered by `rustra codegen`)
- `commands.ts` — type-safe command helper functions
- `contract.ts` — contract hash for compatibility checks

## Tests

```sh
bunx tsc -p examples/crud/tsconfig.json
node --test dist-ts/examples/crud/ts/crud-operations.test.js
```

## Usage from TypeScript

```typescript
import { createItem, getItem, listItems } from './generated/commands.js';

const engine = /* EngineClient */;
const { item } = await createItem(engine, { name: 'Widget', value: 42 });
const result = await getItem(engine, { id: item.id });
```
