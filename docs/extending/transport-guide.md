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

| Host             | Current Transport                                   | Rust Entry Point                               | Alternatives                    |
| ---------------- | --------------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| **Node**         | subprocess stdio (`spawnSync`)                      | `main.rs` → `run_invoke_stdio()`               | napi-rs native module, WASM     |
| **Bun**          | subprocess stdio (`spawnSync`)                      | `main.rs` → `run_invoke_stdio()`               | `bun:ffi` (direct C FFI call)   |
| **Tauri**        | `rustra_dispatch` multiplexing (framework built-in) | `tauri_support::register()` (feature: `tauri`) | None                            |
| **React Native** | C FFI (`extern "C"`)                                | `lib.rs` → `rustra_calculator_invoke`          | TurboModule, Nitro Modules, JSI |

### Node / Bun — subprocess stdio

```ts
// examples/calculator/apps/node-app.ts
import { spawnSync } from 'node:child_process';
import { createNodeEngine } from '../../../packages/node/src/index.js';

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

### React Native — C FFI

Swift calls the Rust C FFI functions directly:

```swift
// examples/react-native-calculator/modules/rustra-calculator/ios/RustraCalculatorModule.swift
@_silgen_name("rustra_calculator_invoke")
func rustra_calculator_invoke(_ payload: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

@_silgen_name("rustra_calculator_free_string")
func rustra_calculator_free_string(_ ptr: UnsafeMutablePointer<CChar>?)

public class RustraCalculatorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RustraCalculator")
    AsyncFunction("invokeRaw") { (payload: String) -> String in
      return payload.withCString { pointer in
        decodeRustString(rustra_calculator_invoke(pointer))
      }
    }
  }
}
```

Rust C FFI entry point:

```rust
// examples/calculator/src/lib.rs
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }
    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() { ... };
    let request = match serde_json::from_str::<Value>(payload) { ... };
    let command = request.get("command").and_then(Value::as_str)...;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    match calculator_package().invoke_json(command, args) {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}
```

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

If C FFI entry points (`rustra_*_invoke`, `rustra_*_free_string`) already exist, switching to an FFI-based transport needs no new entry point.

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

Bun can load `.dylib` / `.so` files directly via `bun:ffi`. Since the Rust C FFI entry points already exist, you can replace only the transport with no Rust-side changes.

### Rust preparation

Add `cdylib` to `examples/calculator/Cargo.toml` (keep `staticlib` for RN iOS):

```toml
[lib]
crate-type = ["rlib", "cdylib", "staticlib"]
```

Build:

```bash
cargo build -p rustra-calculator-example
```

This produces `target/debug/librustra_calculator_example.dylib` (macOS) or `.so` (Linux).

### Bun FFI transport implementation

**Caution**: using `FFIType.cstring` as the return type leaks memory. Memory allocated by Rust's `CString::into_raw()` must be freed with `CString::from_raw()`. Bun's `FFIType.cstring` only copies the C string into a JS string and never frees the original memory. Therefore you must receive the pointer as `FFIType.ptr`, read the string manually, and call `free_string`.

```ts
import { dlopen, FFIType, suffix } from 'bun:ffi';
import { createBunEngine } from '../../../packages/bun/src/index.js';
import { addNumbers } from '../generated/commands.js';
import { configure } from '@rustra/types';

const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_calculator_invoke: {
    args: [FFIType.cstring],
    returns: FFIType.ptr, // not FFIType.cstring — manual memory management required
  },
  rustra_calculator_free_string: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = JSON.stringify({ command, args });
    const rawPtr = lib.symbols.rustra_calculator_invoke(payload);
    const rawResponse = new CString(rawPtr);
    lib.symbols.rustra_calculator_free_string(rawPtr); // Rust frees via CString::from_raw

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

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });
console.log(`bun FFI result: ${result.value}`); // 42
```

### Comparison with the existing Bun app

```ts
// before: subprocess stdio (process spawn overhead)
const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
  input: JSON.stringify({ command, args }),
  encoding: 'utf8',
});

// after: direct FFI call (no process boundary, faster)
const rawResponse = lib.symbols.rustra_calculator_invoke(payload);
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
// crates/calculator-napi/src/lib.rs
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
import { createNodeEngine } from '../../../packages/node/src/index.js';

// load the native module built with napi-rs
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

- **Rapid prototyping**: start with subprocess stdio
- **Production (Node)**: napi-rs or C FFI
- **Production (Bun)**: `bun:ffi`
- **Production (React Native)**: C FFI (current approach)
- **Production (Tauri)**: the `rustra_dispatch` multiplexing pattern (`tauri_support::register`)
