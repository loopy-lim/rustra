[English](./events-and-channels.md)

# 이벤트와 채널

Rust에서 JS로 데이터를 미는 두 경로 — **이벤트**(하나의 이름, 여러 구독자,
fire-and-forget)와 **채널**(호출 귀속 유니캐스트 응답)— 를 한 페이지에 정리한다.

- 동작하는 이벤트 예제: [`examples/streaming`](../examples/streaming/)
- 채널 데모 명령(`channelDemo`): [`examples/calculator`](../examples/calculator/)
- 호스트별 capability 상세: [호환성 매트릭스](compatibility-matrix.ko.md)

## 1. 이벤트 — Rust 선언

빌더에서 `.event::<T>(name)`으로 각 이벤트의 페이로드 타입을 선언하고, `Package`를
든 어디서든 `pkg.emit(name, payload)`로 발행한다:

```rust
use rustra::prelude::*;

#[bridge_type]
pub struct JobProgress { pub job_id: String, pub step: i64, pub total: i64 }

#[command]
pub fn start_job(input: StartJobInput) -> Result<StartJobOutput> {
    // ...작업을 spawn해 pkg.emit("progress.tick", JobProgress { .. }) 호출
    Ok(StartJobOutput { accepted: true })
}

pub fn streaming_package() -> Package {
    rustra::build!("examples.streaming", start_job)
        .event::<JobProgress>("progress.tick")   // <-- 계약 선언
        .done()
}
```

- 선언된 이벤트는 schema.json 최상위 `events` 섹션에 기록되고 `rustra diff`가
  게이트한다 — 제거하거나 페이로드를 바꾸면 breaking change다.
- 선언 없이도 emit은 가능하다(하위호환) — 생성 타입이 없을 뿐이다.
- `emit`은 부하 시 드랍 가능하다 — 버스는 링 버퍼이고 용량은
  `.event_capacity(n)`으로 정한다(기본 1024).

## 2. 이벤트 — 코드젠 산출물

`rustra codegen`을 돌리면 `generated/events.ts`에 타입 있는 이름과 페이로드가
나온다(streaming 예제의 실제 산출물):

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

## 3. 이벤트 — 호스트별 구독

**Tauri** — 생성 엔트리가 global Tauri 이벤트 API에 연결된 `subscribeEvent`를
재export한다(푸시, 폴링 없음):

```ts
import { subscribeEvent } from './generated/tauri.js';

const unsubscribe = await subscribeEvent('progress.tick', (payload) => {
  // payload는 RustraEventPayloads['progress.tick']로 좁혀진다
});
```

Tauri 전용 규칙 둘이 모든 구독에 적용된다. 리스너 콜백이 던지면
`kind: 'tauri.listener_error'` debug 이벤트로 한 번 보고되고(스택 보존; `configureDebug`
싱크에는 항상 도달하고 콘솔에는 `RUSTRA_DEBUG`가 있을 때만 찍힌다) 그 뒤 삼켜진다 —
콜백은 재호출되지 **않고** 형제 리스너는 계속 돈다. 브라우저 `EventTarget`과 같은
정책이다. 구독이 듣는 채널은 `rustra://` + 정규화된 이벤트 이름이다: 코드포인트를 하나씩
순회하며 `-` `/` `:` `_`와 Unicode 문자·숫자는 보존하고(`진행.갱신`은
`rustra://진행_갱신`이 된다) 그 외 코드포인트는 각각 `_` 하나가 되며, NFC 정규화는 하지
않는다. Rust(`sanitize_event_name`)와 TypeScript(`rustraEventChannel`)가 같은 알고리즘을
문자 단위로 똑같이 돌리고, _선언된_ 이벤트 이름 둘이 같은 채널로 수렴하면(`a.b` vs `a_b`)
`Package::build()`가 `event channel collision` 패닉으로 거부하므로 그런 오배선은
런타임에 도달하지 못한다.

**예약 채널** — `rustra://hot-core/swapped`: hot-core 스왑 보고.
`tauri_support::register_dispatch_with_swap_events`(hot-core dylib 모드)로 등록된 Rust
호스트가 모든 스왑 결과를 여기로 민다 — 성공이면 `{ oldContractHash, newContractHash }`,
실패면 `{ error }`; 정적 `register` / `register_with_events` 등록 아래에서는 이 채널이
침묵한다. TypeScript에서는 `@rustra/tauri`의 `subscribeHotSwap`로 구독한다. 이벤트
이름은 정규화를 그대로 통과한다(`/`는 보존 코드포인트) — 채널은 정확히
`rustra://hot-core/swapped`다.

**React Native** — RN의 `subscribeEvent(name, cb, options?)`는 JSI 싱크 푸시다.
CallInvoker 없는 호스트에서는 `pollMs`를 넘겨 C++ 디스패처 큐를 당기는 JS 폴링
드레인 루프를 돌린다:

```ts
import { subscribeEvent } from '@rustra/react-native';

const unsubscribe = subscribeEvent('progress.tick', (payload) => {
  /* ... */
});
// CallInvoker 없는 호스트: subscribeEvent('progress.tick', cb, { pollMs: 100 });
```

**Node** — 이벤트는 루프 transport(`createNodeLoopTransport`)를 탄다.
`events:"push"` 핸드셰이크가 성공하면 푸시(stdout 0xfffd 프레임)를 쓰고, 아니면
`__drainEvents` 폴링(`RUSTRA_NODE_EVENT_POLL_MS`, 기본 100ms)으로 폴백한다.
one-shot invoke 바이너리는 이벤트를 전달할 수 없다 — 첫 구독에서
`event.unavailable`이 throw된다:

```ts
import { createNodeLoopTransport, subscribeEvent } from '@rustra/node';

const transport = createNodeLoopTransport({ command: binaryPath, codecs });
const unsubscribe = subscribeEvent(transport, 'progress.tick', (payload) => {
  /* ... */
});
```

**Bun** — FFI 이벤트 브릿지는 생성 `bun.ts` 엔트리가 자동 배선한다;
`subscribeEvent`는 FFI 싱크 푸시 + 폴링 폴백으로 동작한다. 전체 흐름은
[`examples/streaming/apps/node-app.ts`](../examples/streaming/apps/node-app.ts)과
[`examples/calculator/apps/bun-ffi-app.ts`](../examples/calculator/apps/bun-ffi-app.ts).

> 푸시 모드(Node stdout, Bun FFI)는 첫 구독 **이전**의 emit을 버린다 — 먼저
> 구독하거나, 구독 전 emit이 중요하면 폴링을 쓴다. 전달 경로 상세:
> [호환성 매트릭스 — 이벤트 전달 경로](compatibility-matrix.ko.md#시그널-시맨틱-상세).

## 4. 채널 — Rust 쪽

채널은 한 번의 호출에 귀속된 유니캐스트 응답 스트림이다. 명령은
`ChannelHandle`(wire에서는 평범한 `u32`)을 받아 문자열 페이로드를 보낸다:

```rust
use rustra::channels;

#[bridge_type]
pub struct ChannelDemoInput { pub channel: ChannelHandle, pub ticks: i64 }

#[command]
pub fn channel_demo(input: ChannelDemoInput) -> Result<ChannelDemoOutput> {
    for tick in 0..input.ticks {
        // 핸들이 닫히거나 드랍되면 false — 조용히-무시 계약
        let _ = channels::ChannelHandle(input.channel)
            .send(&format!(r#"{{"tick": {tick}}}"#));
    }
    Ok(/* ... */)
}
```

`ChannelHandle::send(&str) -> bool`은 JSON 페이로드를 흘린다. `send_bytes(&[u8]) -> bool`은
바이너리 페이로드(예: Frame 프로토콜 프레임)를 흘리며 바이너리 경로로 발급된 핸들이어야 한다 —
JSON 핸들이면 `false`를 돌려주는데, 호출 종료로 만료된 핸들에 send 할 때와 똑같다.

핸들 발급과 sender 배선은 호스트 어댑터가 한다 — 앱의 Rust 코드는 `send`만
부른다. Rust 소유 객체에는 `ResourceHandle`이 같은 패턴을 따른다.

## 5. 채널 — JS 쪽

모든 호스트가 동일한 `{ handle, close() }` 계약을 노출한다:

**Tauri** (`@rustra/tauri`, `rustra_channel_create` + listen으로 발급):

```ts
import { createChannel } from '@rustra/tauri';
import { channelDemo } from './generated/commands.js';

const channel = await createChannel((payload) => console.log(payload));
await channelDemo({ channel: channel.handle, ticks: 3 });
await channel.close();
```

**React Native** (`@rustra/react-native`, JSI — 진짜 유니캐스트; CallInvoker
없는 호스트는 `{ pollMs }`):

```ts
import { createChannel } from '@rustra/react-native';

const channel = createChannel((payload) => console.log(payload));
await channelDemo({ channel: channel.handle, ticks: 3 });
channel.close();
```

**Node** — 루프 transport에서 `await createNodeChannel(transport, cb)`(loop-stdio
예약 프레임, 백그라운드 스레드 send 안전). **Bun** — `rustra_ffi_channel_*` FFI
심볼 위의 `createBunChannelBridge(options)(cb)`(JS 스레드 send 전용). 바이너리
프레임 변형은 모든 호스트에 존재한다: `createBytesChannel`(React Native),
`createChannelBytes`(Tauri), `createNodeBytesChannel`(Node),
`createBunChannelBytesBridge`(Bun).

호스트별 발급 경로와 정확한 capability 셀:
[호환성 매트릭스 — 채널 전달 경로](compatibility-matrix.ko.md#채널-전달-경로).

## 6. 무엇을 쓸지

| 필요                                               | 사용                                     |
| -------------------------------------------------- | ---------------------------------------- |
| 여러 구독자에게 진행률/상태 방송                   | 이벤트(`.event::<T>` + `subscribeEvent`) |
| 한 번의 호출에 귀속된 응답 스트림(요청 → N 프레임) | 채널(`ChannelHandle` + `createChannel`)  |
| 호출 사이에 참조되는 Rust 소유 객체                | `ResourceHandle`(같은 u32 핸들 개념)     |

이벤트는 fire-and-forget(부하 시 드랍 가능), 채널은 핸들이 열려 있는 동안
호출 귀속 전달을 보장한다.
