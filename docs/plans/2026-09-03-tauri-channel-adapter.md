# Tauri 채널 어댑터 구현 계획 (매트릭스 Tauri Channels ❌ 해소)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `createTauriEngine` 호스트에서 `createChannel(callback)` 으로 채널을 발급하고 Rust `ChannelHandle::send` → 웹뷰 JS 콜백으로 도달시킨다 — 호환성 매트릭스의 Tauri Channels 셀을 ❌→✅로 바꾼다.

**Architecture:** spike research(`docs/research/2026-09-02-tauri-channel-spike.md`)가 확정한 경로 — Rust 측 `tauri_support.rs`에 `rustra_channel_create`/`rustra_channel_drop` Tauri 커맨드를 추가(AppHandle 캡처 클로저를 `ChannelHost::register_channel`에 등록, `app.emit_str("rustra://channel/{handle}")` 푸시), JS 측 `packages/tauri`에 RN `createChannel`과 동형 계약 `{ handle, close() }` 어댑터를 `subscribeEvent` 위에 얹는다. 코어(channels/channels_host/channels_handles/ffi_channel/wire) 무변경.

**Tech Stack:** Rust (tauri 2, `tauri::test::MockRuntime` 헤드리스 테스트), TypeScript (`packages/tauri`).

**계약 근사 명시(필수 문서화):** 채널 계약은 유니캐스트(channels.rs:17-21)지만 Tauri emit은 브로드캐스트다. `rustra://channel/{handle}` 채널명으로 **근사**하며, 같은 프로세스의 다른 웹뷰가 같은 채널명을 listen하면 프레임을 볼 수 있다. 이 근사는 JS 어댑터가 `listen`의 unlisten을 close로 연결하고 Rust sender가 핸들 귀속 전송을 하므로 "단일 발급자 = 단일 수신자" 정상 흐름에서는 유니캐스트와 동일하게 동작한다. getting-started와 매트릭스에 이 수준 차이를 명시한다.

---

### Task 1: Rust 측 채널 커맨드 (`rustra_channel_create`/`rustra_channel_drop`)

**Files:**

- Modify: `crates/rustra/src/tauri_support.rs`
- Test: `examples/tauri-calculator/src-tauri/tests/channel_push.rs` (신설 — event_push.rs 패턴)

**Step 1: 채널 네임스페이스 상수 + 커맨드 구현 전 failing 테스트 작성**

`examples/tauri-calculator/src-tauri/tests/channel_push.rs` — event_push.rs의 MockRuntime 패턴을 그대로 따른다:

```rust
//! Tauri 채널 어댑터(headless) 검증 — 발급자 배선 + 채널 푸시 도달.
//!
//! `rustra_channel_create` 가 AppHandle 캡처 sender를 `ChannelHost`에
//! 등록하고, Rust `ChannelHandle::send`가 `app.emit("rustra://channel/{handle}")
//! 으로 도달하는지 증명한다. 웹뷰/이벤트 루프 없음(MetaMockRuntime).

use rustra::channels;
use rustra::tauri_support::{self, CHANNEL_EVENT_PREFIX};
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

#[test]
fn channel_create_registers_sender_and_send_reaches_listener() {
    let package = Package::builder("example.channel-push").build();
    let builder = tauri_support::register_with_events(package, mock_builder());
    let app = builder.build(mock_context(noop_assets())).expect("mock app builds");

    // JS 어댑터가 invoke로 발급받는 것과 동일한 경로: 커맨드 직접 호출은
    // State<'_, RustraState>가 필요하므로 헤드리스 테스트는 tauri::command의
    // 본체 함수를 쓴다(본체는 State 없는 순수 함수로 추출).
    let handle = tauri_support::create_channel_for(
        &app,
        Arc::new(|payload| { /* 콜백 수신 기록 */ }),
    );
    assert!(handle > 0, "valid channel handle");

    // 채널명으로 listen (JS 어댑터와 동일 규칙)
    let received = ...; // Arc<Mutex<Vec<(u32, String)>>>
    app.listen(format!("{CHANNEL_EVENT_PREFIX}{handle}"), move |event| {
        received.lock().unwrap().push(event.payload().to_string());
    });

    let ch = channels::ChannelHandle(handle);
    assert!(ch.send(r#"{"step":1}"#));
    // 리스너가 {"step":1} 을 받았는지 검증
    // close 후 send → false 검증
}
```

(구체 코드는 구현 시 event_push.rs 실측 패턴 + 실패 확인하며 완성한다.)

**Step 2: 테스트 실패 확인** — `cargo test -p rustra-tauri-calculator --test channel_push` → `CHANNEL_EVENT_PREFIX` 미존재로 컴파일 실패.

**Step 3: `tauri_support.rs` 구현**

```rust
/// 채널 프레임의 이벤트 채널 접두사 — `rustra://channel/{handle}`.
/// 이벤트 이름공간(`rustra://{name}`)과 분리되는 예약 세그먼트다: 스키마에
/// `channel` 이벤트를 선언한 패키지와의 충돌을 구조적으로 차단한다.
pub const CHANNEL_EVENT_PREFIX: &str = "rustra://channel/";

/// JS↔Rust 채널 발급/해제 커맨드 본체 — `State` 없는 순수 함수로 추출해
/// MockRuntime 헤드리스 테스트가 직접 호출한다(#[tauri::command] 래퍼는 이를
/// 감싸기만 한다 — event_push.rs가 진들 배선을 증명하고 이건 본체를 증명한다).
pub fn create_channel_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    callback: std::sync::Arc<dyn Fn(&str) + Send + Sync>,
) -> u32 {
    // sender 클로저가 핸들과 AppHandle을 모두 캡처해야 하므로 2단계:
    // reserve_handle → register_channel_with_handle (FFI 경로와 동일 관용).
    let handle = channels::host().reserve_handle();
    if handle == 0 {
        return 0; // 핸들 공간 소진 — 호출자(JS 어댑터)가 loud-fail.
    }
    let app_for_sender = app.clone();
    channels::host().register_channel_with_handle(
        handle,
        Arc::new(move |payload: &str| {
            let channel = format!("{CHANNEL_EVENT_PREFIX}{handle}");
            if let Err(error) = app_for_sender.emit_str(&channel, payload.to_string()) {
                eprintln!("rustra: tauri channel emit failed (handle {handle}): {error}");
            }
        }),
    );
    handle
}

pub fn drop_channel_for<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, handle: u32) -> bool {
    channels::host().drop_channel(handle)
}

#[tauri::command]
pub fn rustra_channel_create(
    app: tauri::AppHandle<tauri::Wry>,
    callback: String, // 아래 "설계 결정" 참고 — 실제로는 채널 발급만 하고 콜백은 listen 쪽
) -> Result<u32, Value> { ... }

#[tauri::command]
pub fn rustra_channel_drop(app: tauri::AppHandle<tauri::Wry>, handle: u32) -> bool { ... }
```

**핵심 설계 결정 — 발급 커맨드는 callback을 받지 않는다.** spike가 지적했듯 Tauri IPC는 함수 값을 실어 보낼 수 없다. 대신:

- `createChannelFor(app)` 본체는 **핸들만 선점**하고, sender 클로저는 AppHandle+handle을 캡처해 `rustra://channel/{handle}` emit으로 고정 배선한다(콜백 불필요 — 어댑터 JS가 listen으로 받는다).
- `#[tauri::command] rustra_channel_create()` → `{ handle }` 반환. JS 어댑터가 `invoke('rustra_channel_create')` → `listen('rustra://channel/{handle}', cb)` 순서로 배선한다.
- `rustra_channel_drop(handle)` → `drop_channel`. JS `close()`가 invoke한다.

sender가 핸들 캡처를 위해 reserve→insert 2단계가 필요한 이유: sender 클로저 자체가 handle을 알아야 `rustra://channel/{handle}`을 emit할 수 있기 때문 — FFI 경로(`ffi_channel.rs:115-135`)가 `reserve_handle`+`register_channel_with_handle`을 쓰는 것과 동일 관용.

**Step 4: `register_with_events`(및 `register`)의 `generate_handler!`에 커맨드 추가**

`register()`의 `generate_handler![rustra_dispatch, rustra_dispatch_profiled, rustra_dispatch_batch]`에 `rustra_channel_create, rustra_channel_drop`를 추가한다. `register`에만 추가할지 `register_with_events`만 추가할지는 — 채널은 이벤트 싱크와 무관하므로 **양쪽에 추가**한다(채널은 emit 기반이지만 `Package::emit` 싱크 설치와 무관하게 `app.emit_str`을 직접 쓴다).

**Step 5: 테스트 통과 확인**

```bash
cargo test -p rustra-tauri-calculator --test channel_push
```

Expected: PASS. 추가 검증:

- 같은 프로세스에서 handle 1씩 증가(단조 증가),
- drop 후 재발급 핸들은 새 handle,
- `send` 후 listener 도달 + close 후 `send → false`.

**Step 6: 커밋** — `feat(tauri): rustra_channel_create/drop — AppHandle 캡처 sender로 채널 프레임 푸시`

---

### Task 2: JS 어댑터 `createChannel` (`packages/tauri`)

**Files:**

- Create: `packages/tauri/src/tauri-channels.ts`
- Modify: `packages/tauri/src/index.ts` (re-export)
- Test: `packages/tauri/test/tauri-channels.test.ts`

**Step 1: failing 테스트**

```ts
import { describe, expect, test } from 'bun:test';
import { createChannel } from '../src/tauri-channels.js';

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;
type Listen = (
  channel: string,
  handler: (event: { payload: string }) => void | Promise<void>,
) => Promise<() => void>;

function harness() {
  const invocations: Array<{ cmd: string; args?: unknown }> = [];
  const listeners = new Map<string, Set<(payload: string) => void>>();
  const unlisteners: Array<() => void> = [];
  const invoke: Invoke = async (cmd, args) => {
    invocations.push({ cmd, args });
    if (cmd === 'rustra_channel_create') return { handle: 7 };
    if (cmd === 'rustra_channel_drop') return true;
    throw new Error('unknown command');
  };
  const listen: Listen = async (channel, handler) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(handler);
    listeners.set(channel, set);
    const unlisten = () => {
      set.delete(handler);
    };
    unlisteners.push(unlisten);
    return unlisten;
  };
  return { invoke, listen, invocations, listeners, unlisteners };
}
```

검증 항목:

1. `createChannel(cb, { invoke, listen })` → `{ handle: 7, close }` — invoke로 `rustra_channel_create` 호출.
2. `listen('rustra://channel/7', ...)` 배선 — 채널명이 `rustra://channel/${handle}`.
3. Rust가 프레임을 push하면 cb가 파싱된 객체로 호출 — `handler({ payload: '{"v":1}' })` → `cb({v:1})`.
4. `close()` → `rustra_channel_drop` invoke + unlisten 실행 + 이후 프레임 무시.
5. invoke가 실패하면 loud-fail(에러 전파).

**Step 2: 테스트 실패 확인** — 모듈 미존재.

**Step 3: 구현**

```ts
import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import { rustraEventChannel } from './tauri-events.js';

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<packages/tauri>...
```

계약(RN `react-native-events.ts:13-38` 동형):

```ts
export type TauriChannelInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export type TauriListen = (
  channel: string,
  handler: (event: { payload: string }) => unknown,
) => Promise<() => void>;

export function createChannel(
  callback: (payload: unknown) => void,
  io?: { invoke?: TauriInvoke; listen?: TauriListen },
): Promise<{ readonly handle: TauriChannelHandle; close(): Promise<boolean> }>;
```

- `invoke`/`listen` 미전달 시 `globalThis.__TAURI__` 자동 감지(`requireTauriListen` 패턴 재사용 — core.invoke, event.listen).
- 발급: `invoke('rustra_channel_create')` → `{ handle }` → `listen(\`rustra://channel/${handle}\`, handler)`.
- 핸들 검증: non-negative safe integer 아니면 loud-fail(RN과 동일).
- 프레임 파싱: `JSON.parse` 1회, 실패 시 원본 문자열 전달(tauri-events.ts:71-79와 동일 관용).
- `close()`: closed 플래그 → `invoke('rustra_channel_drop', { handle })` + unlisten. `close()`는 `Promise<boolean>` (RN 동기 vs Tauri 비동기 — invoke/listen이 비동기이므로).

**Step 4: index.ts re-export + 테스트 통과**

```bash
bun test packages/tauri
```

**Step 5: 코드젠 SubscribeFn 정합 타입 추가(선택이 아닌 필수)** — `tauri-events.ts:92-113`의 정합 패턴을 채널용으로도: 채널 생성 팩토리의 콜백 시그니처가 코드젠 채널 마커(`RustraChannel = number`)와 정합하는지 tsc 레벨 고정. YAGNI 적용 — 코드젠은 채널 인자를 `ChannelHandle = number`로만 발행하므로, 정합 대상은 "콜백 (payload: T) => void + { handle, close() } 반환" 구조가 RN과 동형인지만 확인하면 된다.

**Step 6: 커밋** — `feat(tauri): createChannel 어댑터 — invoke 발급 + listen 콜백 브릿지`

---

### Task 3: 예제 + 문서 + 매트릭스 + changeset

**Files:**

- Modify: `docs/compatibility-matrix.md` (+ `docs/compatibility-matrix.ko.md`)
- Modify: `docs/rust-api-guide.md` 채널 절
- Modify: `docs/getting-started.md` (근사 유니캐스트 주의)
- Modify: `examples/tauri-calculator/src-tauri/tests/channel_push.rs` (E2E로 승격 — listener = JS 어댑터 규칙 재현)
- Create: `.changeset/tauri-channel-adapter.md`

**Step 1: E2E 강화** — channel_push.rs에 `channelDemo` 커맨드까지 흐르는 왕복 검증: `create_channel_for`로 발급 → `package.invoke_json("channelDemo", { channel: handle, ticks: 3 })` → 리스너 3프레임 도달 + `sent=3, droppedSends=0`.

**Step E2E 성공 후 Step 2: 매트릭스 갱신**

`docs/Channels` 행의 Tauri 셀:

```
✅ `createChannel(cb)` — invoke 발급 + `rustra://channel/{handle}` listen 근사 유니캐스트
```

- Notes에 근사 계약 명시(다른 웹뷰 listen 시 프레임 관측 가능 — 단일 발급자=단일 수신자 정상 흐름에서는 유니캐스트와 동일).

**Step 3: guide/getting-started 갱신 + changeset**

`.changeset/tauri-channel-adapter.md`:

```md
---
'@rustra/tauri': minor
---

Tauri 채널 어댑터: `createChannel(callback)` ...
```

(Rust 측 rustra crate는 별도 Cargo workspace 발행 — docs/release-procedure.md. tauri_support.rs는 rustra crate의 tauri feature 코드라 crates.io 발행 대상 — release-procedure에 따라 수동.)

**Step 4: ko/en 문서 동기화 확인** — `bun run test:docs` 게이트가 지키는 `docs:sync` 영역을 건드리면 en/ko 쌍으로 갱신.

**Step 5: 커밋** — `docs(tauri): 채널 어댑터 착지 — 매트릭스 ✅ + 근사 유니캐스트 명시 + changeset`
