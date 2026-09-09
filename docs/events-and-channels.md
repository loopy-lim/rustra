English | [한국어](./events-and-channels.ko.md)

# Events and Channels

How to push data from Rust to JS: **events** (one name, many subscribers,
fire-and-forget) and **channels** (invocation-scoped unicast replies). Both start
as Rust declarations and end as typed JS — the full flow in one page.

- Working event example: [`examples/streaming`](../examples/streaming/)
- Channel demo command (`channelDemo`): [`examples/calculator`](../examples/calculator/)
- Per-host capability details: [compatibility matrix](compatibility-matrix.md)

## 1. Events — Rust declaration

Declare each event's payload type on the builder with `.event::<T>(name)`, and
publish it from anywhere holding the `Package` with `pkg.emit(name, payload)`:

```rust
use rustra::prelude::*;

#[bridge_type]
pub struct JobProgress { pub job_id: String, pub step: i64, pub total: i64 }

#[command]
pub fn start_job(input: StartJobInput) -> Result<StartJobOutput> {
    // ...spawn work that calls pkg.emit("progress.tick", JobProgress { .. })
    Ok(StartJobOutput { accepted: true })
}

pub fn streaming_package() -> Package {
    rustra::build!("examples.streaming", start_job)
        .event::<JobProgress>("progress.tick")   // <-- the contract declaration
        .done()
}
```

- Declared events are recorded in schema.json's top-level `events` section and
  gated by `rustra diff` — removing one or changing its payload is a breaking
  change.
- Undeclared events can still be emitted (backwards compatibility), they just
  have no generated type.
- `emit` is droppable under load: the bus is a ring buffer whose capacity is set
  with `.event_capacity(n)` (default 1024).

## 2. Events — what codegen produces

After `rustra codegen`, `generated/events.ts` carries the typed names and
payloads (shown from the real streaming example output):

```ts
/** 선언된 rustra 이벤트 이름 (Rust `PackageBuilder::event`). */
export type RustraEventName = 'job.done' | 'progress.tick';

/** 이벤트 이름 → 페이로드 타입 매핑. */
export type RustraEventPayloads = {
  'job.done': { jobId: string; steps: number | bigint };
  'progress.tick': { jobId: string; step: number | bigint; total: number | bigint };
};

/** 타입 안전 이벤트 구독 — 페이로드가 자동으로 좁혀진다. */
export function onRustraEvent<N extends RustraEventName>(
  subscribe: SubscribeFn,
  name: N,
  callback: (payload: RustraEventPayloads[N]) => void,
): (() => void) | Promise<() => void>;
```

## 3. Events — subscribing per host

**Tauri** — the generated entry re-exports `subscribeEvent` wired to the global
Tauri event API (push, no polling):

```ts
import { subscribeEvent } from './generated/tauri.js';

const unsubscribe = await subscribeEvent('progress.tick', (payload) => {
  // payload is typed as RustraEventPayloads['progress.tick']
});
```

Two Tauri-specific rules apply to every subscription. A listener callback that
throws is reported once as a `kind: 'tauri.listener_error'` debug event (stack
preserved; it always reaches the `configureDebug` sink and hits the console only
under `RUSTRA_DEBUG`) and is then swallowed — the callback is **not** re-invoked and
sibling listeners keep running, the same policy as a browser `EventTarget`. The
channel a subscription listens on is `rustra://` plus the sanitized event name:
code points are walked one at a time, `-` `/` `:` `_` and Unicode letters/digits
are kept (so `진행.갱신` becomes `rustra://진행_갱신`), every other code point turns
into one `_`, and no NFC normalization is applied. Rust (`sanitize_event_name`) and
TypeScript (`rustraEventChannel`) run the same algorithm character for character,
and `Package::build()` panics with `event channel collision` when two _declared_
event names would map to the same channel (`a.b` vs `a_b`), so that misrouting
cannot reach runtime.

**React Native** — the RN `subscribeEvent(name, cb, options?)` is push via the
JSI sink. On CallInvoker-less hosts, pass `pollMs` to run the client-side drain
loop that pulls the C++ dispatcher queue:

```ts
import { subscribeEvent } from '@rustra/react-native';

const unsubscribe = subscribeEvent('progress.tick', (payload) => {
  /* ... */
});
// CallInvoker-less host: subscribeEvent('progress.tick', cb, { pollMs: 100 });
```

**Node** — events ride the loop transport (`createNodeLoopTransport`). Push
(stdout 0xfffd frames) is preferred with the `events:"push"` handshake; otherwise
it falls back to `__drainEvents` polling (`RUSTRA_NODE_EVENT_POLL_MS`, default
100 ms). A one-shot invoke binary cannot deliver events — the first subscription
throws `event.unavailable`:

```ts
import { createNodeLoopTransport, subscribeEvent } from '@rustra/node';

const transport = createNodeLoopTransport({ command: binaryPath, codecs });
const unsubscribe = subscribeEvent(transport, 'progress.tick', (payload) => {
  /* ... */
});
```

**Bun** — the FFI event bridge is auto-wired by the generated `bun.ts` entry;
`subscribeEvent` pushes through the FFI sink with a polling fallback. Full flow in
[`examples/streaming/apps/node-app.ts`](../examples/streaming/apps/node-app.ts)
and [`examples/calculator/apps/bun-ffi-app.ts`](../examples/calculator/apps/bun-ffi-app.ts).

> Push modes (Node stdout, Bun FFI) discard emits that happen **before** the
> first subscription — subscribe first, or use polling if pre-subscription emits
> matter. Delivery-path details:
> [compatibility matrix — event delivery path](compatibility-matrix.md#signal-semantics-in-detail).

## 4. Channels — Rust side

A channel is a unicast reply stream scoped to one invocation. The command
receives a `ChannelHandle` (a plain `u32` on the wire) and sends string payloads
to it:

```rust
use rustra::channels;

#[bridge_type]
pub struct ChannelDemoInput { pub channel: ChannelHandle, pub ticks: i64 }

#[command]
pub fn channel_demo(input: ChannelDemoInput) -> Result<ChannelDemoOutput> {
    for tick in 0..input.ticks {
        // false when the handle was closed/dropped — silent-ignore contract
        let _ = channels::ChannelHandle(input.channel)
            .send(&format!(r#"{{"tick": {tick}}}"#));
    }
    Ok(/* ... */)
}
```

`ChannelHandle::send(&str) -> bool` streams a JSON payload. `send_bytes(&[u8]) -> bool`
streams a binary payload (an rkyv V2 frame, for example) and needs a handle issued
through the binary path — on a JSON handle it returns `false`, exactly like sending on
a handle that expired when the call ended.

The host adapter issues the handle and wires the sender — app Rust code only
calls `send`. Resource-style handles (`ResourceHandle`) follow the same pattern
for Rust-owned objects.

## 5. Channels — JS side

Every host exposes the same `{ handle, close() }` contract:

**Tauri** (`@rustra/tauri`, issued via `rustra_channel_create` + listen):

```ts
import { createChannel } from '@rustra/tauri';
import { channelDemo } from './generated/commands.js';

const channel = await createChannel((payload) => console.log(payload));
await channelDemo({ channel: channel.handle, ticks: 3 });
await channel.close();
```

**React Native** (`@rustra/react-native`, JSI — true unicast; `{ pollMs }` on
CallInvoker-less hosts):

```ts
import { createChannel } from '@rustra/react-native';

const channel = createChannel((payload) => console.log(payload));
await channelDemo({ channel: channel.handle, ticks: 3 });
channel.close();
```

**Node** — `await createNodeChannel(transport, cb)` on a loop transport
(loop-stdio reservation frames; background-thread send is safe). **Bun** —
`createBunChannelBridge(options)(cb)` over the `rustra_ffi_channel_*` FFI symbols
(JS-thread send only). Binary frame variants exist on every host:
`createBytesChannel` (React Native), `createChannelBytes` (Tauri),
`createNodeBytesChannel` (Node), and `createBunChannelBytesBridge` (Bun).

Per-host issuance paths and the exact capability cells:
[compatibility matrix — channel delivery path](compatibility-matrix.md#channel-delivery-path).

## 6. Choosing between them

| Need                                               | Use                                         |
| -------------------------------------------------- | ------------------------------------------- |
| Broadcast progress/status to any subscribers       | Event (`.event::<T>` + `subscribeEvent`)    |
| Reply stream tied to one call (request → N frames) | Channel (`ChannelHandle` + `createChannel`) |
| Rust-owned object referenced across calls          | `ResourceHandle` (same u32 handle idea)     |

Events are fire-and-forget (droppable under load); channels guarantee
invocation-scoped delivery while the handle is open.
