English | [한국어](./README.ko.md)

# @rustra/tauri

Adapter that lazily detects Tauri's global IPC and connects it to the shared
`EngineClient`.

## Zero-config default path

Enable the global API in the Tauri configuration and register the Rust package with one
line.

```json
{ "app": { "withGlobalTauri": true } }
```

```rust
let builder = rustra::tauri_support::register_with_events(app_package(), tauri::Builder::default());
```

Add only `"tauri": {}` to `rustra.json`. Because the generated entry point lazily detects
the invoke and event APIs, the frontend imports command and subscription functions
directly.

```ts
import { addNumbers, subscribeEvent } from './generated/tauri.js';

await subscribeEvent('progress.tick', console.log);
const result = await addNumbers({ a: 20, b: 22 });
```

## Public API

```ts
type TauriInvoke = (command: string, args?: unknown) => Promise<unknown> | unknown;

type TauriEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createTauriEngine(options: { invoke: TauriInvoke }): TauriEngineClient;
```

## Usage examples

```ts
import { createTauriEngine } from '@rustra/tauri';
import { invoke } from '@tauri-apps/api/core';

const engine = createTauriEngine({ invoke });
```

Internally it routes through Tauri's `rustra_dispatch` command:

```ts
engine.invoke('addNumbers', { a: 2, b: 3 });
// → options.invoke("rustra_dispatch", { command: "addNumbers", args: { a: 2, b: 3 } })
```

This package does not force-install `@tauri-apps/api`, so it does not conflict with
existing Tauri versions. Apps that do not use `withGlobalTauri` can use the existing
`createTauriEngine({ invoke })` as an explicit escape hatch.

On the Rust side, enable the `tauri` feature and register the package with
`tauri_support::register()`:

```rust
use rustra::tauri_support::register;

let builder = register(my_package, tauri::Builder::default());
```

This adapter works through the `rustra_dispatch` endpoint that `register()` installs.

A real WebView IPC example and the Release performance receipts are in
[`tauri-calculator`](../../examples/tauri-calculator/). Measured on 2026-08-24 macOS
arm64: 279.04µs average, p50 300µs — not a direct-Rust-call smoke test, but 3,000 calls
of the generated `addNumbers` from a hidden WKWebView.
