English | [한국어](./synchronous-bindings.ko.md)

# Synchronous command bindings

`bindSync<I, O>(command)` returns an ordinary synchronous function. Configure the engine and finish bootstrap before binding:

```ts
import { bindSync } from '@rustra/types';
import { rustra } from './generated/react-native.js';
import type { AddNumbersInput, AddNumbersOutput } from './generated/types.js';

await rustra.ready();
const add = bindSync<AddNumbersInput, AddNumbersOutput>('addNumbers');
const result = add({ a: 20, b: 22 });
```

The existing generated command functions continue returning Promises and retain their cancellation and timeout options. A synchronous binding accepts input only and throws command errors synchronously.

The first supported host is React Native JSI with the atomic native binding factory. A generated static native codec, an exact match between compiled native codec, JS and Rust core contracts, and a frozen native registry are required. Release packages are frozen automatically; an explicitly frozen development package also qualifies. Asynchronous transports, missing native support, legacy metadata, unannotated commands and async commands throw `sync.unavailable`. Unknown generated command names throw `command.not_found`. There is no caller option to assert synchronous eligibility. Type parameters provide compile-time typing; they do not replace native contract validation.

Rust `register!` and `build!` preserve the original `#[command]` function's execution kind, including `async fn` wrappers. Existing `.command(...)`, `.command_fn(...)` and buffer registration remain unknown unless the producer supplies `.command_execution(name, CommandExecution::Sync)` or `Async`. Declare the actual producer behavior; an async macro adapter must remain Async. This metadata changes the generated contract hash, so regenerate the TS and native artifacts together. It does not change command IDs, request/response bytes, or FFI function signatures.

Bindings observe global engine replacement and disposal. Every native call captures one immutable core table. Hot-core replacement is revalidated before the next call; a call already in progress retains its captured table through encoding, dispatch, response overflow and owned-buffer release. A changed contract, non-frozen registry, or non-sync command is rejected before its handler runs. Updating JS metadata to match a changed Rust core cannot bypass stale compiled codecs; rebuild the native codecs as well. Older generated C++ without compiled identity keeps its existing API compilation and Promise behavior, while the new binding fails closed. Frozen registries cannot change schema generation within one core, and Rust FFI registration is first-wins; native core identity therefore supplies the per-call lifetime guard without a separate JS-to-native generation probe.

Native payload bounds and fresh-output ownership are preserved. As on existing typed routes, `FrameEngineOptions.maxPayloadBytes` is a JS-codec preflight option, not a second per-engine native limit. Bindings initially require native static codecs and do not use JS codec fallback.

Benchmark receipts distinguish `sync-public`, `sync-internal-diagnostic`, and `async-public`. Public synchronous performance requires measurement of the complete guarded binding; native diagnostic timing is not a public API result.
