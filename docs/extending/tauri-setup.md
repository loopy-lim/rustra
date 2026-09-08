English | [한국어](./tauri-setup.ko.md)

# Adding rustra to an Existing Tauri App

A file-by-file walkthrough for putting rustra commands into a Tauri v2 app you
already have. Five files change; nothing else in the app does. A complete
working app built exactly this way lives in
[`examples/tauri-calculator`](../../examples/tauri-calculator/).

| #   | File                            | Change                                                          |
| --- | ------------------------------- | --------------------------------------------------------------- |
| 1   | Rust core crate — `src/lib.rs`  | define `#[command]` functions + a package function              |
| 2   | Rust core crate — `rustra.json` | add `"tauri": {}` and the codegen generator keys                |
| 3   | `src-tauri/Cargo.toml`          | depend on the core crate + `rustra` with the `tauri` feature    |
| 4   | `src-tauri/src/main.rs`         | register the package with `tauri_support::register_with_events` |
| 5   | `src-tauri/tauri.conf.json`     | set `app.withGlobalTauri: true`                                 |
| 6   | frontend (e.g. `src/app.ts`)    | import from `../generated/tauri.js` — no engine setup code      |

## 1. Rust core crate: commands and package

In the crate that holds your business logic (here `rustra-app`, adjust paths to
your layout):

```rust
// rustra-app/src/lib.rs
use rustra::prelude::*;

#[bridge_type]
pub struct AddNumbersInput { pub a: i64, pub b: i64 }

#[bridge_type]
pub struct AddNumbersOutput { pub value: i64 }

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { value: input.a + input.b })
}

pub fn package() -> Package {
    rustra::build!("dev.rustra.app", add_numbers).done()
}
```

## 2. `rustra.json` — turn on the Tauri host

Create (or extend) `rustra.json` in the Rust crate. The `tauri` block is an
empty object — Cargo metadata plus standard Tauri APIs are inferred:

```json
{
  "schema": "./generated/schema.json",
  "output": "./generated",
  "codegen": {
    "rustManifest": "./Cargo.toml",
    "rustBinary": "generate"
  },
  "tauri": {}
}
```

Then generate the client surfaces:

```bash
bunx --bun @rustra/cli codegen --config rustra.json
```

This renders `generated/tauri.ts` (plus `types.ts`, `commands.ts`, `contract.ts`).
If the schema probe binary does not exist yet, add a `generate` bin to the crate
that calls `package().generate_typescript()?.write_schema_to_dir("generated")` —
see [getting started §2-4](../getting-started.md).

## 3. `src-tauri/Cargo.toml` — feature and dependency

```toml
[dependencies]
rustra = { version = "0.8", features = ["tauri"] }
rustra-app = { path = "../rustra-app" }   # your core crate
```

## 4. `src-tauri/src/main.rs` — one-line registration

```rust
use rustra::tauri_support;

fn main() {
    let builder = tauri_support::register_with_events(
        rustra_app::package(),
        tauri::Builder::default(),
    );
    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
```

- `register_with_events` is the production default: `register` + event push
  wiring (`Package::emit` → `rustra://{name}` Tauri events).
- `register(package, builder)` is the variant without event wiring.
- All commands are multiplexed through the single `rustra_dispatch` Tauri
  command — you never list commands on the Tauri side.

## 5. `src-tauri/tauri.conf.json` — enable the global API

The generated entry detects the IPC and event APIs lazily through the global
Tauri API. Turn it on inside `app`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "My App",
  "identifier": "dev.rustra.myapp",
  "app": {
    "withGlobalTauri": true
  }
}
```

(This is the actual shape used by
[`examples/tauri-calculator/src-tauri/tauri.conf.json`](../../examples/tauri-calculator/src-tauri/tauri.conf.json).)
Apps that do not want the global API can instead pass
`createTauriEngine({ invoke })` to `configure()` — see the
[transport guide §2 Tauri](./transport-guide.md).

## 6. Frontend — import and call

Install the adapter once, then import the generated entry:

```bash
bun add @rustra/tauri @rustra/types
```

```ts
// src/app.ts
import { addNumbers, subscribeEvent } from '../rustra-app/generated/tauri.js';

// Rust-side Package::emit arrives as a typed push event (no polling)
const unsubscribe = await subscribeEvent<{ value: number }>('calc.tick', (payload) => {
  console.log('tick', payload.value);
});

const result = await addNumbers({ a: 20, b: 22 }); // 42
```

The entry installs the engine lazily on first call — there is no
`configure()`, no invoke plumbing in app code. Build and run the app as usual
(`tauri dev` / `tauri build`).

## Verify and troubleshoot

- `bunx --bun @rustra/cli doctor --config rustra.json` — checks the toolchain,
  manifest wiring, and generated-output freshness.
- First-call contract failure (`contract.mismatch`): the generated TS and the
  Rust binary were built from different schemas — re-run codegen and rebuild.
- Permissions/CSP for OS capabilities and the Tauri ACL are a separate layer:
  see the [platform permissions guide](../platform-permissions.md).
- Per-host capability differences (events, channels) are in the
  [compatibility matrix](../compatibility-matrix.md).
