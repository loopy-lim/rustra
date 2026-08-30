English | [한국어](./adding-host.ko.md)

# Guide to Adding a New Host Adapter

## 1. Minimum Requirements

Adding a new host adapter requires implementing exactly one interface.

```ts
type EngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};
```

This is all rustra requires on the TypeScript side. The generated command functions (such as `addNumbers`) all go through the global `invoke` from `@rustra/types`, which uses the `EngineClient` installed with `configure(engine)`:

```ts
// examples/calculator/generated/commands.ts
export function addNumbers(input: AddNumbersInput): Promise<AddNumbersOutput> {
  return invoke<AddNumbersOutput>('addNumbers', input);
}
```

---

## 2. Creating a New Adapter

### Directory layout

```
packages/<host>/src/index.ts    ← adapter factory function
packages/<host>/README.md       ← usage documentation
```

All existing adapters follow the same pattern:

```
packages/node/src/index.ts
packages/bun/src/index.ts
packages/react-native/src/index.ts
packages/tauri/src/index.ts
```

### Writing the factory function

Every adapter exposes a factory function that "receives a transport and returns an `EngineClient`". Follow the existing pattern as-is.

#### Basic pattern (Node/Bun style)

```ts
// packages/<host>/src/index.ts

export type MyHostInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type MyHostEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createMyHostEngine(transport: MyHostInvokeTransport): MyHostEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

#### Framework built-in pattern (Tauri style)

If the framework has its own invoke mechanism, the adapter can wrap commands:

```ts
// packages/tauri/src/index.ts (for reference)
export type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

export function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      // Tauri routes through a single command: rustra_dispatch
      return (await options.invoke('rustra_dispatch', { command, args: args ?? {} })) as T;
    },
  };
}
```

#### Native module pattern (React Native style)

This pattern injects the native module directly:

```ts
// packages/react-native/src/index.ts (for reference)
export type ReactNativeRustraModule = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export function createReactNativeEngine(
  nativeModule: ReactNativeRustraModule,
): ReactNativeEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await nativeModule.invoke(command, args)) as T;
    },
  };
}
```

---

## 3. Choosing the Rust Entry Point

Choose one of the following four ways for the Rust side to communicate with TypeScript.

### C FFI (`extern "C"`) — universal, high performance

**Best for:** React Native, Bun (`bun:ffi`), embedded systems, integration with C/C++ projects

**Advantages:**

- Bindings in any language (Swift, Kotlin, C, Python, etc.)
- Function-call-level performance
- Direct memory management keeps overhead minimal

**Implementation:**

```rust
// lib.rs
use std::ffi::{CStr, CString, c_char};
use serde_json::{Value, json};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_mypackage_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }

    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() {
        Ok(s) => s,
        Err(e) => return json_string(json!({ "ok": false, "error": format!("not UTF-8: {e}") })),
    };

    let request: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(e) => return json_string(json!({ "ok": false, "error": format!("invalid json: {e}") })),
    };

    let command = request.get("command").and_then(Value::as_str)
        .ok_or_else(|| "missing command").unwrap(); // handle properly in real code
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));

    match my_package().invoke_json(command, args) {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_mypackage_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

fn json_string(value: Value) -> *mut c_char {
    let text = serde_json::to_string(&value)
        .unwrap_or_else(|e| format!(r#"{{"ok":false,"error":"json encode failed: {e}"}}"#));
    CString::new(text).expect("no interior null").into_raw()
}
```

Specify `cdylib` or `staticlib` in Cargo.toml:

```toml
[lib]
crate-type = ["rlib", "cdylib"]   # dynamic library (Bun FFI, Python, etc.)
# or
crate-type = ["rlib", "staticlib"] # static library (iOS, Android, etc.)
```

### stdio (subprocess) — universal, simple to implement

**Best for:** Node.js, Bun, CLI tools, rapid prototyping

**Advantages:**

- Very simple to implement
- Process isolation provides safety
- Language independent (uses only stdin/stdout)

**Drawbacks:**

- Per-call process spawn overhead
- Cannot keep a process alive (stateless)

**Implementation:**

```rust
// main.rs
fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = my_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
```

TypeScript side:

```ts
import { spawnSync } from 'node:child_process';

function invokeRuntime(command: string, args: unknown): unknown {
  const output = spawnSync('./target/debug/my-package', ['invoke'], {
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

### napi-rs — high performance for Node.js

**Best for:** Node.js-only production environments

**Advantages:**

- Best performance as a Node.js native addon
- Type-safe Rust ↔ JavaScript conversion
- Async support (`Promise` generated automatically)

**Implementation:**

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn rustra_invoke(command: String, args: Option<String>) -> Result<String> {
    let args_value = match args {
        Some(ref a) => serde_json::from_str(a)?,
        None => serde_json::json!({}),
    };
    let result = my_package().invoke_json(&command, args_value)?;
    Ok(serde_json::to_string(&serde_json::json!({ "ok": true, "result": result }))?)
}
```

### Framework built-in — Tauri

**Best for:** Tauri applications

Tauri has its own `invoke` mechanism, so you only need to register the package with `rustra::tauri_support::register`. This function registers a single command handler named `rustra_dispatch` on the Tauri builder and multiplexes all rustra commands through this endpoint:

```rust
// src-tauri/src/main.rs
let builder = rustra::tauri_support::register(my_package(), tauri::Builder::default());
builder.run(tauri::generate_context!()).expect("failed to run");
```

> **Note:** Using `tauri_support` requires enabling the `tauri` feature in `Cargo.toml`.
>
> ```toml
> rustra = { path = "...", features = ["tauri"] }
> ```

This pattern also serves as a reference for integrating with other frameworks. If a framework supports single-endpoint command routing, you can implement a multiplexing adapter in a similar way.

### Decision tree

```
Adding a new host?
│
├─ Node.js only?
│   ├─ Need maximum performance? → napi-rs
│   └─ Prefer fast implementation? → subprocess stdio
│
├─ Bun only?
│   ├─ Need maximum performance? → bun:ffi (direct C FFI)
│   └─ Prefer fast implementation? → subprocess stdio
│
├─ React Native?
│   └─ C FFI → wrap with Expo Modules Core
│
├─ Tauri?
│   └─ Framework built-in invoke
│
├─ Another native environment? (iOS, Android, embedded)
│   └─ C FFI → wrap with the platform's FFI mechanism
│
└─ Universal / language independent?
    └─ subprocess stdio
```

---

## 4. How to Add Tests

### Writing a runtime app

Add an app for the new host under `examples/calculator/apps/`.

```ts
// examples/calculator/apps/<host>-app.ts
import { addNumbers } from '../generated/commands.js';
import { createMyHostEngine } from '../../../packages/myhost/src/index.js';
import { configure } from '@rustra/types';

// transport implementation
const engine = createMyHostEngine({
  invoke(command: string, args?: unknown) {
    // real transport implementation
    return invokeViaMyTransport(command, args);
  },
});

// tests
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`<host> runtime result: ${result.value}`);
```

### Writing an adapter test (mocking)

This test validates only the adapter logic, without a real Rust binary. The existing `tauri-app.ts` and `react-native-app.ts` use this pattern:

```ts
// examples/calculator/apps/<host>-app.ts (mocked version)
import { addNumbers } from '../generated/commands.js';
import { createMyHostEngine } from '../../../packages/myhost/src/index.js';
import { configure } from '@rustra/types';

const calls: Array<{ command: string; args: unknown }> = [];

const engine = createMyHostEngine({
  async invoke(command: string, args?: unknown) {
    calls.push({ command, args });
    return { value: 42 }; // mocked response
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

if (JSON.stringify(calls) !== JSON.stringify([{ command: 'addNumbers', args: { a: 20, b: 22 } }])) {
  throw new Error(`unexpected calls: ${JSON.stringify(calls)}`);
}

console.log(`<host> adapter test passed`);
```

### Adding Bun scripts to package.json

```json
{
  "scripts": {
    "test:adapter:myhost": "bun examples/calculator/apps/myhost-app.ts",
    "test:runtime:myhost": "cargo build -p rustra-calculator-example && bun examples/calculator/apps/myhost-app.ts"
  }
}
```

Existing script patterns for reference:

```json
{
  "scripts": {
    "test:adapter:tauri": "bun examples/calculator/apps/tauri-app.ts",
    "test:adapter:react-native": "bun examples/calculator/apps/react-native-app.ts",
    "test:adapters": "bun run test:adapter:tauri && bun run test:adapter:react-native && bun run test:adapter:myhost",
    "test:runtime": "bun run test:runtime:node && bun run test:runtime:bun && bun run test:runtime:myhost",
    "test:compat": "bun run test:ts:node && bun run test:ts:bun && bun run test:adapters && bun run test:runtime"
  }
}
```

### Running the full suite

```bash
# full compatibility tests
bun run test:compat

# individual tests
bun run test:adapter:myhost       # adapter mock tests
bun run test:runtime:myhost       # real Rust runtime tests
```

---

## 5. Worked Example: Electron Adapter

This walks through the full process of adding an adapter for Electron.

### Step 1: Create the package

```
packages/electron/src/index.ts
```

### Step 2: Write the adapter

```ts
// packages/electron/src/index.ts
export type ElectronInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export type ElectronEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

export function createElectronEngine(transport: ElectronInvokeTransport): ElectronEngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return (await transport.invoke(command, args)) as T;
    },
  };
}
```

### Step 3: Choose the Rust entry point

Electron is Node.js-based, so start with subprocess stdio:

```ts
// examples/calculator/apps/electron-app.ts
import { spawnSync } from 'node:child_process';
import { addNumbers } from '../generated/commands.js';
import { createElectronEngine } from '../../../packages/electron/src/index.js';
import { configure } from '@rustra/types';

const engine = createElectronEngine({
  invoke(command, args) {
    const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
      input: JSON.stringify({ command, args }),
      encoding: 'utf8',
    });

    if (output.status !== 0) {
      throw new Error(output.stderr || `runtime exited ${output.status}`);
    }

    const response = JSON.parse(output.stdout) as { ok: true; result: unknown };
    return response.result;
  },
});

configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`electron runtime result: ${result.value}`);
```

### Step 4: Add test scripts

```json
{
  "test:adapter:electron": "bun examples/calculator/apps/electron-app.ts",
  "test:runtime:electron": "cargo build -p rustra-calculator-example && bun examples/calculator/apps/electron-app.ts"
}
```

### Step 5: Switch to napi-rs later (optional)

If production needs more performance, swap only the transport for napi-rs:

```ts
const engine = createElectronEngine({
  invoke(command, args) {
    const native = require('./my-package.node');
    const rawResponse = native.rustra_invoke(command, JSON.stringify(args));
    const response = JSON.parse(rawResponse);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  },
});
```

The adapter code (`packages/electron/src/index.ts`) stays unchanged. Only the transport is replaced.
