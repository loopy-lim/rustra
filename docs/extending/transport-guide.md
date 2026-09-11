English | [한국어](./transport-guide.ko.md)

# Transport Replacement Guide

## 1. What Is a Transport?

In rustra, a **transport** is the concrete means by which adapter internals actually call Rust code.

An adapter (`createNodeEngine`, `createBunEngine`, etc.) merely receives a transport and wraps it into an `EngineClient`; it does not implement the transport itself. Replacing only the transport therefore changes how you communicate with Rust while reusing the same adapter code.

### Adapter-transport separation

```ts
// packages/node/src/index.ts
export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type NodeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

`createNodeEngine` accepts a `NodeInvokeTransport` and simply calls the transport's `invoke`. **How** the call reaches Rust is entirely up to the transport implementation.

---

## 2. Current Implementation Status

Ordinary apps do not assemble transports at all — the generated host entry points
(`generated/node.ts`, `generated/bun.ts`, `generated/tauri.ts`,
`generated/react-native.ts`) wire the transport lazily. The table below is the
baseline you start from; everything after it in this guide is for **manual
assembly** — custom hosts, custom transports, or replacing the default.

| Host             | Default (generated entry)                                                   | Rust entry point                                             | Manual-assembly alternatives                                                                 |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Node**         | one-shot Cargo binary + stdio, contract check via `__rustra_contract`       | `main.rs` → `run_invoke_stdio()`                             | your own `spawnSync` stdio, `createNodeLoopTransport` (servers), napi-rs native module, WASM |
| **Bun**          | cdylib + stable C ABI + Frame (`rustra_ffi_invoke_frame`)                   | `lib.rs` → `rustra::native_entry!` + `register_ffi(...)`     | `bun:ffi` direct C FFI call (§4, JSON path)                                                  |
| **Tauri**        | `rustra_dispatch` multiplexing (framework built-in)                         | `tauri_support::register[_with_events]()` (feature: `tauri`) | `createTauriEngine({ invoke })` with a custom invoke function                                |
| **React Native** | autolinked JSI + Frame (`invokeFrame`) via `@rustra/generated-react-native` | `rustra::native_entry!` (exports `rustra_mobile_init`)       | custom JSON transport (`createReactNativeEngine`), TurboModule, Nitro Modules                |

### Node — manual subprocess stdio

The default Node entry spawns a Cargo binary that speaks the one-shot stdio
protocol (`{command, args}` → `{ok, result}` + the reserved `__rustra_contract`
probe). If you assemble the process transport yourself, the shape is:

```ts
// manual assembly — illustrative; the generated node.ts does this for you
import { spawnSync } from 'node:child_process';
import { createNodeEngine } from '@rustra/node';

const engine = createNodeEngine({
  invoke(command, args) {
    return invokeCalculatorRuntime(command, args);
  },
});

function invokeCalculatorRuntime(command: string, args: unknown): unknown {
  const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
    input: JSON.stringify({ command, args }),
    encoding: 'utf8',
  });

  if (output.status !== 0) {
    throw new Error(output.stderr || `runtime exited ${output.status}`);
  }

  const response = JSON.parse(output.stdout) as { ok: true; result: unknown };
  return response.result;
}
```

Rust stdio entry point:

```rust
// examples/calculator/src/main.rs
fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = calculator_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
```

### React Native — C FFI (manual JSON path)

> The example-local symbols `rustra_calculator_invoke`/`rustra_calculator_free_string`
> shown here in older revisions were removed (2026-09-03 legacy cleanup). The current
> surface is the **core public C ABI** (`rustra_ffi_*`), which serves any package.

On the Rust side, register the package for the core FFI and export the zero-config
init — no hand-written per-app symbols:

```rust
// examples/calculator/src/lib.rs
use rustra::ffi::FfiFormat;
use rustra::prelude::*;

pub fn calculator_package() -> Package {
    let pkg = rustra::build!("examples.calculator", add_numbers /*, … */).done();
    // rustra_ffi_invoke_json / rustra_ffi_invoke_postcard now serve this package
    pkg.register_ffi_with_default(FfiFormat::Json);
    pkg
}

// exports rustra_mobile_init() — hosts call it during lazy bootstrap
rustra::native_entry!(calculator_package);
```

The JSON-over-bytes contract of the core entry point:

```text
rustra_ffi_invoke_json(payload: *const u8, payload_len: usize, out_len: *mut usize) -> *mut u8
  request:  JSON {"command":"...","args":{...}} as raw bytes
  response: JSON {"ok":bool,"result":...,"error":"..."} as raw bytes
  the returned buffer must be freed with rustra_ffi_free(ptr, len) — the exact pair
```

Swift binds the same symbols directly:

```swift
// a hand-rolled JSI/module bridging layer (custom hosts only — the default RN
// path is the generated @rustra/generated-react-native package)
@_silgen_name("rustra_mobile_init")
func rustra_mobile_init()

@_silgen_name("rustra_ffi_invoke_json")
func rustra_ffi_invoke_json(
    _ payload: UnsafePointer<UInt8>, _ payloadLen: Int,
    _ outLen: UnsafeMutablePointer<Int>
) -> UnsafeMutablePointer<UInt8>?

@_silgen_name("rustra_ffi_free")
func rustra_ffi_free(_ ptr: UnsafeMutablePointer<UInt8>, _ len: Int)

func invokeRawJSON(_ payload: String) throws -> String {
    rustra_mobile_init() // idempotent — registers the package on first call
    let bytes = Array(payload.utf8)
    let outLen = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    defer { outLen.deallocate() }
    guard let raw = rustra_ffi_invoke_json(bytes, bytes.count, outLen) else {
        throw NSError(domain: "rustra", code: 1, userInfo: [NSLocalizedDescriptionKey: "FFI invoke returned null"])
    }
    defer { rustra_ffi_free(raw, outLen.pointee) } // free with the exact ptr/len pair
    return String(decoding: UnsafeBufferPointer(start: raw, count: outLen.pointee), as: UTF8.self)
}
```

Other core FFI symbols on the same cdylib/staticlib: `rustra_ffi_invoke` (default
format dispatch), `rustra_ffi_invoke_postcard`, `rustra_ffi_invoke_frame`,
`rustra_ffi_get_schema`, `rustra_ffi_contract_hash` — the full list with stability
tiers is in the [Rust API guide — FFI appendix](../rust-api-guide.md) and the
[versioning policy](../versioning-policy.md).

### Tauri — the `rustra_dispatch` multiplexing pattern

The Tauri transport does not pass through individual commands; instead it **multiplexes every command through the single `rustra_dispatch` endpoint**.

```ts
// packages/tauri/src/index.ts
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      // routes all commands through a single rustra_dispatch
      return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
    },
  };
}
```

On the Rust side, the package is registered with the Tauri builder via `rustra::tauri_support::register`. This function sets up the `rustra_dispatch` command handler and state management automatically.

```rust
// examples/tauri-calculator/src-tauri/src/main.rs
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());
    builder.run(tauri::generate_context!()).expect("failed to run tauri calculator app");
}
```

Using `tauri_support` requires enabling the `tauri` feature in `Cargo.toml`:

```toml
rustra = { path = "...", features = ["tauri"] }
```

---

## 3. Transport Replacement Procedure (Generalized 3 Steps)

### Step 1: Add a new Rust entry point (only if needed)

A crate that registers its package for the core FFI (`rustra::native_entry!` +
`register_ffi(...)`, see §2) already exports the core C ABI
(`rustra_ffi_invoke_json`, `rustra_ffi_free`, …) — switching to an FFI-based
transport then needs no new entry point.

If you need a new communication mechanism (napi-rs, WASM, etc.), add the corresponding entry point to `lib.rs`.

```toml
# check crate-type in Cargo.toml
[lib]
crate-type = ["rlib", "staticlib"]
```

With `staticlib` included, a `.a` / `.lib` static library is built and can be used for C FFI.

### Step 2: Change the transport implementation in the app

Inject the new transport into the adapter's factory function. Do not modify the adapter code itself.

```ts
// before: subprocess stdio
const engine = createNodeEngine({
  invoke(command, args) {
    return invokeViaSubprocess(command, args);
  },
});

// after: the new transport
const engine = createNodeEngine({
  invoke(command, args) {
    return invokeViaNewTransport(command, args);
  },
});
```

### Step 3: Verify against existing tests for regressions

```bash
# run all adapter compatibility tests
bun run test:compat

# runtime-specific tests
bun run test:runtime:node
bun run test:runtime:bun
```

The tests call `configure(engine)` and then check that `addNumbers({ a: 20, b: 22 })` returns `42`, verifying that the same result is returned even after the transport changes.

---

## 4. Example: Replacing with Bun FFI

Bun can load `.dylib` / `.so` files directly via `bun:ffi`. The **default generated
`bun.ts` entry** already does this over the Frame symbols; the JSON path below is
the manual-assembly variant for custom hosts, using the same core C ABI
(`rustra_ffi_invoke_json`).

### Rust preparation

Add `cdylib` to the crate's `Cargo.toml` (keep `staticlib` for RN iOS):

```toml
[lib]
crate-type = ["rlib", "cdylib", "staticlib"]
```

Register the package for the core FFI in `lib.rs` (see §2 React Native for the full
snippet) — `rustra::native_entry!(my_package)` plus
`pkg.register_ffi_with_default(FfiFormat::Json)`. Build:

```bash
cargo build -p rustra-calculator-example
```

This produces `target/debug/librustra_calculator_example.dylib` (macOS) or `.so` (Linux).

### Bun FFI transport implementation

The request/response are raw bytes (`Buffer`/`ArrayBuffer`), not C strings — Bun's
`FFIType.cstring` must not be used for the return value. Receive the pointer as
`FFIType.ptr`, copy it, and free it with `rustra_ffi_free(ptr, len)` using the exact
pair:

```ts
import { dlopen, FFIType, suffix, toArrayBuffer } from 'bun:ffi';
import { createBunEngine } from '@rustra/bun';
import { configure } from '@rustra/types';
import { addNumbers } from '../generated/commands.js';

const outLength = new BigUint64Array(1); // usize out-param
const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_mobile_init: { args: [], returns: FFIType.void },
  rustra_ffi_invoke_json: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr], // payload, payload_len, out_len
    returns: FFIType.ptr, // not FFIType.cstring — manual memory management required
  },
  rustra_ffi_free: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
});
lib.symbols.rustra_mobile_init(); // idempotent package registration

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = Buffer.from(JSON.stringify({ command, args }), 'utf8');
    outLength[0] = 0n;
    const rawPtr = lib.symbols.rustra_ffi_invoke_json(payload, BigInt(payload.length), outLength);
    const len = Number(outLength[0]);
    let responseText: string;
    try {
      // copy into JS-owned memory before freeing the Rust allocation
      responseText = new TextDecoder().decode(toArrayBuffer(rawPtr, 0, len));
    } finally {
      lib.symbols.rustra_ffi_free(rawPtr, BigInt(len));
    }

    const response = JSON.parse(responseText) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'Rust invoke failed');
    }

    return response.result;
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`bun FFI result: ${result.value}`); // 42
```

The release-ready variant (Frame caller-buffer path with contract verification,
no manual dlopen at all) is the generated `bun.ts` entry — see
[`bun-ffi-app.ts`](../../examples/calculator/apps/bun-ffi-app.ts).

### Comparison with the subprocess stdio transport

```ts
// subprocess stdio (process spawn overhead per call)
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});

// direct FFI call (no process boundary, faster)
const rawPtr = lib.symbols.rustra_ffi_invoke_json(payload, BigInt(payload.length), outLength);
```

Advantages:

- **No process spawn overhead**: no process is created per call
- **Lower latency**: function-call-level performance
- **Shared memory**: no cross-process serialization/deserialization

---

## 5. Example: Replacing with Node napi-rs

[napi-rs](https://napi.rs/) lets you expose Rust functions as Node.js native addons (`.node` files).

### Rust implementation

```rust
// examples/calculator-napi/src/lib.rs — generic JSON pattern
// (the shipped example now binds the Frame buffer path instead; see its README)
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rustra_calculator_example::calculator_package;
use serde_json::json;

#[napi]
pub fn rustra_invoke(command: String, args: Option<String>) -> Result<String> {
    let args_value = match args {
        Some(ref a) => serde_json::from_str(a).map_err(|e| {
            Error::from_reason(format!("invalid args JSON: {e}"))
        })?,
        None => json!({}),
    };

    let result = calculator_package()
        .invoke_json(&command, args_value)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    serde_json::to_string(&json!({ "ok": true, "result": result }))
        .map_err(|e| Error::from_reason(format!("json encode failed: {e}")))
}
```

Build:

```bash
cargo build --release
# or use the napi-rs CLI
napi build --platform --release
```

### Node transport implementation

```ts
import { createNodeEngine } from '@rustra/node';

// load the native module built with napi-rs (examples/calculator-napi)
const native = require('./calculator-napi.node');

const engine = createNodeEngine({
  async invoke(command: string, args?: unknown): Promise<unknown> {
    const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
    const rawResponse = native.rustra_invoke(command, argsJson);

    const response = JSON.parse(rawResponse) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'Rust invoke failed');
    }

    return response.result;
  },
});

// used the same way
import { addNumbers } from '../generated/commands.js';
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`napi-rs result: ${result.value}`); // 42
```

### Comparison with the existing Node app

```ts
// before: subprocess stdio
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});
const response = JSON.parse(output.stdout);

// after: direct native module call
const rawResponse = native.rustra_invoke(command, argsJson);
```

Advantages:

- **Performance**: direct function calls without subprocess overhead
- **Type safety**: napi-rs handles Rust ↔ JavaScript type conversion
- **Async support**: napi-rs's `#[napi]` can generate `Promise`-based async functions automatically

---

## 6. Summary: Choosing a Transport

| Criterion             | subprocess stdio    | C FFI                    | napi-rs   | Framework built-in       |
| --------------------- | ------------------- | ------------------------ | --------- | ------------------------ |
| **Effort**            | Low                 | Medium                   | Medium    | Low (framework-provided) |
| **Performance**       | Low (process spawn) | High                     | High      | High                     |
| **Compatibility**     | Universal           | Needs language bindings  | Node only | That framework only      |
| **Debugging**         | Easy (isolated)     | Hard (memory management) | Medium    | Medium                   |
| **Process isolation** | Yes                 | No                       | No        | No                       |

**Recommendations:**

- **Rapid prototyping**: start with the generated entries (one-shot stdio on Node, cdylib FFI on Bun)
- **Production (Node)**: the generated entry; napi-rs or C FFI for hot paths
- **Production (Bun)**: the generated `bun.ts` FFI entry
- **Production (React Native)**: the autolinked JSI entry (default); core `rustra_ffi_*` C ABI only for custom native hosts
- **Production (Tauri)**: the `rustra_dispatch` multiplexing pattern (`tauri_support::register`)
