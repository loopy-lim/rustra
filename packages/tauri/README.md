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

### Hot-core swap events (experimental)

`subscribeHotSwap` subscribes to the reserved `rustra://hot-core/swapped` channel — it
fires only when the Rust side registers with
`tauri_support::register_dispatch_with_swap_events` (the hot-core dylib loop); under the
static registrations the channel is silent.

```ts
type HotSwapEvent = { oldContractHash: string; newContractHash: string } | { error: string };

function subscribeHotSwap(
  callback: (event: HotSwapEvent) => void,
  listen?: TauriListen,
): Promise<() => void>;
```

The success payload carries both the old and the new contract hash, so it can double as
a cache-resync signal: compare the hashes to decide whether schema-dependent caches need
refetching. Failures are reported, never dropped. See
[events-and-channels](../../docs/events-and-channels.md) for the reserved-channel rules.

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

## Channel ownership and lifetime

JS-created Tauri channels use a native `Channel<InvokeResponseBody>` tied to the
issuing physical WebView. `close()` revokes its native lease and disposes the JS
callback; navigation, destruction, and app cleanup release owner resources. The
`ipc-channel-chunks-v1` handshake rejects old broadcast-based native hosts: update
`@rustra/tauri` and rebuild Rust together. Global setup needs `core.Channel` plus
Tauri's callback-cleanup API; without globals, pass an explicit
`createIpcChannel(onMessage)` factory returning `{ value, dispose() }` alongside
`invoke`. Passing `listen` alone cannot create a channel.

Raw fragments are at most 968 bytes, below Tauri's 1,024-byte direct IPC threshold.
Native messages are capped at the smaller of the runtime payload limit and 16 MiB.
The core defaults to a **1 MiB** payload limit, so an unconfigured native path is
also limited to 1 MiB. JS reassembly has a 16 MiB ceiling and expires incomplete
messages after 30 seconds.
JSON is decoded once after final reassembly, preserving JSON strings as strings;
binary callbacks receive `Uint8Array`. Ordinary event subscriptions still broadcast.
Trusted Rust `create_channel_for`/`create_bytes_channel_for` helpers deliberately
retain app-wide delivery. Mock IPC and JS tests cover the ownership protocol;
physical WebView teardown still needs native GUI acceptance on each target.

The Rust `tauri` feature currently pins Tauri 2.11.1: the private chunk path is verified against that version's direct IPC delivery threshold. Review the native/JS channel boundary and rerun its tests before updating this dependency. An app requiring a different exact Tauri version must resolve that compatibility requirement first.
