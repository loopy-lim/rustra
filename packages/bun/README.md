English | [한국어](./README.ko.md)

# @rustra/bun

Adapter that automatically connects the Rustra cdylib over a stable C ABI in Bun 1.4
environments.

## Zero-config default path

Declare a host-neutral entry in the Rust crate with one line and enable `cdylib`.

```rust
rustra::native_entry!(app_package);
```

```toml
[lib]
crate-type = ["rlib", "cdylib"]
```

Add only `"bun": {}` to `rustra.json`. The generated file builds Release and Debug library
candidates from Cargo metadata, verifies the actual ABI symbols, and lazily installs the
rkyv V2 engine.

```ts
import { addNumbers } from './generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });
```

If the deployment layout differs, use `RUSTRA_BUN_LIBRARY=/absolute/path/to/libapp.dylib`.

## Public API

```ts
type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

type BunEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createBunEngine(transport: BunInvokeTransport): BunEngineClient;
```

## Usage examples

### subprocess-based

```ts
import { createBunEngine } from '@rustra/bun';
import { spawn } from 'bun';

const engine = createBunEngine({
  async invoke(command, args) {
    const proc = spawn(['cargo', 'run', '-p', 'my-crate', '--', 'invoke']);
    // Communicates over JSON stdin/stdout
    return sendAndReceive(proc, { command, args });
  },
});
```

### bun:ffi-based

```ts
import { createBunEngine } from '@rustra/bun';
import { dlopen } from 'bun:ffi';

const lib = dlopen('libmy_crate.so', {/* FFI signature */});

const engine = createBunEngine({
  invoke(command, args) {
    return lib.symbols.invoke(JSON.stringify({ command, args }));
  },
});
```

`createBunEngine(transport)` is the escape path for HTTP or custom FFI. The default
`createBunBootstrap` copies Rust-owned responses into JS-owned `ArrayBuffer`s, frees them
with the exact pointer/length pair, and also verifies the schema/contract hash over the
same ABI.

On 2026-08-24 macOS arm64 Release, the full path of the generated `addNumbers` API
averaged 2.27µs, p50 2.21µs, and about 439,961 ops/s. This is not just the adapter
function timed in isolation; it includes the codec, FFI, Rust invoke, and response
ownership transfer after lazy bootstrap. The reproduction code is
[`bun-performance.ts`](../../examples/calculator/apps/bun-performance.ts).
