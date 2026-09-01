English | [한국어](./README.ko.md)

# Calculator Example

A complete example that uses `rustra` in a separate Rust crate. It shows how application authors actually use it.

## Generation and Run

```bash
bun run --cwd examples/calculator codegen
bun run test:runtime:node
bun run test:runtime:bun
```

The Node example lazily discovers a generated binary candidate, and the Bun example lazily links a generated cdylib candidate against the stable ABI. Neither requires `configure()`, process spawning, `dlopen`, or pointer lifetime management in application code.

```ts
import { addNumbers, rustra } from '../generated/node.js'; // bun.js for Bun

const { value } = await addNumbers({ a: 20, b: 22 });
console.log(value);
rustra.dispose();
```

The executables live in [`apps/node-app.ts`](apps/node-app.ts) and
[`apps/bun-ffi-app.ts`](apps/bun-ffi-app.ts).

## What the Example Shows

1. **Type definitions** — define `AddNumbersInput`, `AddNumbersOutput` with `Serialize + Deserialize + JsonSchema`
2. **Command registration** — mark handler functions with `#[command]` and register them via `Package::builder(...).command_fn(...)`
3. **Local invoke** — type-safe invocation with `package.invoke("addNumbers", ...)`
4. **TypeScript generation** — contract probe publishes `schema.json` (`generate_schema` bin), then `rustra codegen` renders the TS/C++ surfaces from it
5. **Host generated entrypoints** — `node.ts`, `bun.ts`, `tauri.ts`, `react-native.ts`
6. **Native entrypoint** — `native_entry!` in one line shares the stable C ABI and the RN staticlib
7. **High-performance options** — measured Node persistent loop/N-API and Bun FFI rkyv V2

## Generated Files

The following files are generated in the `examples/calculator/generated/` directory:

- `schema.json` — package schema
- `types.ts` — TypeScript type definitions
- `commands.ts` — command helper functions
- `contract.ts` — contract hash
- `node.ts`, `bun.ts`, `tauri.ts`, `react-native.ts` — zero-config bootstrap per host

## Generated Command Helper

```ts
import { addNumbers } from '../generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
console.log(result.value); // 42
```

This code uses a helper generated on top of `createGeneratedFields2` together with the Node host entry. Because the generated host file installs the lazy engine once, the helper is called without an engine parameter. Bun imports `../generated/bun.js` the same way, and a manual `configure()` is only needed when injecting a custom transport.

## Real-World Performance Check

```bash
bun run bench:hosts
```

[`apps/node-performance.ts`](apps/node-performance.ts) measures the Node default one-shot,
persistent loop, and N-API rkyv V2 respectively, and
[`apps/bun-performance.ts`](apps/bun-performance.ts) times the generated Bun FFI path.
The default Node path is a CLI/low-frequency path for simple deployment. On server hot
paths you must explicitly choose the loop or N-API so that a process is not started
per call.

## Compatibility Test

Validates the generated TypeScript client on Node and Bun:

```bash
bun run test:compat
```
