# 역방향 콜백(Rust→JS 콜백 인자) 리서치 (2026-09-07)

상태: complete. 조사 방법 — `.worktrees/integrate`(feat/integrate-1.0-track)의
코드 직접 확인. 모든 사실 주장에 `file:line` 근거를 붙인다(경로는 저장소 루트
기준). 추측은 "미확인"으로 명시. 이 문서의 결론을 받아
`docs/plans/2026-09-07-reverse-callbacks-design.md` 가 설계를 결정한다.

## 0. 해소 대상 격차 (인용)

`docs/research/2026-09-07-competitive-landscape.md` 의 격차 정의:

> **4. 역방향 콜백 인터페이스(반환값 있는 JS 함수)** — UniFFI
> callback_interface/Nitro 반환값 있는 콜백 대비, rustra 채널은 유니캐스트
> 응답뿐. (`:43`)

같은 문서의 권장(`:67-69`): "다음 안정화 트랙 후보로 **타입화 에러**(성비
최고)와 **역방향 콜백**(채널 인프라 재사용 가능)을 권장." 그리고
`docs/plans/2026-09-07-platform-interop-stabilization-design.md:131` 의
"남는 일" 목록에 "역방향 콜백(반환값 있는 JS 함수, 격차 #4)" 이 등록돼
있다.

선행 인프라(직전 트랙 착지분, 같은 문서 `:117-120`): 4호스트 채널(Tauri
createChannel, Node 예약 프레임 0xfffb 계열, Bun FFI `rustra_ffi_channel_*`,
RN JSI)과 바이너리 채널(`ChannelBytesSender`/`send_bytes`).

## 1. 용어 정리 — 이 트랙의 "역방향 콜백"은 무엇인가

세 가지 역방향(Rust→JS) 표면이 이미 존재하고, 이 트랙이 추가하려는 것은
네 번째다.

| 표면                                 | 방향/수명                                                           | 반환값                                          | 현재 상태                  |
| ------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| 이벤트 (`Package::emit`)             | 브로드캐스트, 패키지 수명                                           | 없음(fire-and-forget)                           | 4호스트 (`events.rs` 계열) |
| 채널 (`ChannelHandle`)               | 유니캐스트, **호출자가 명시 open/close**                            | 없음(전달 성공 bool만)                          | 4호스트 (본 문서 §2-3)     |
| async 완료 콜백 (`invokeTypedAsync`) | 1회성, 호출 수명                                                    | 결과/에러 1회                                   | RN 전용 (§5.4)             |
| **역방향 콜백 (이 트랙)**            | **커맨드 인자로 전달, 커맨드 스코프**, 핸들러 실행 중 0회 이상 호출 | **설계 결정 대상** (단방향 vs request/response) | 부재                       |

핵심 구분(채널과의 차이):

1. **커맨드 스코프 수명** — 채널은 JS 가 `createChannel()` 후 명시
   `close()` 한다(tauri-channels.ts:119-124 예시). 콜백은 "커맨드 인자"로서
   커맨드 완료/에러/취소와 함께 자동 해제되는 수명이 본질이다.
2. **선언적 페이로드 타입** — 채널 페이로드는 `unknown`/`Uint8Array`
   (node-channels.ts:58, tauri-channels.ts:127). 콜백은 커맨드 계약(스키마)의
   일부로 페이로드 타입이 코드젠돼야 경쟁(UniFFI callback_interface)과
   대등해진다.
3. **반환값/에러 역전파 가능성** — 채널 `send` 는 "도달 bool"
   (channels_handles.rs:21-30)만 돌려준다. 콜백이 JS 함수의 **반환값**을
   Rust 로 되돌릴 수 있는가가 격차 #4의 요체다(§6).
4. **호출 순서·백프레셔 계약** — 채널은 각 호스트 구현편의(RN 은
   drop-oldest, §3.4). 콜백은 계약으로 명시해야 한다(§7).

## 2. 채널 코어 인프라 전수

### 2.1 계약 문서 (channels.rs 상단)

- wire 에는 **정수 핸들만** 실린다 — 콜백/객체 참조를 직렬화하지 않는다
  (channels.rs:5-15).
- 채널 핸들(u32)은 **호스트가 발급**, Rust 가 `channel_send(handle,
payload_json)` 로 흘린다. "호출별 회신 채널" — 커맨드 인자로 전달되어 해당
  호출에만 귀속 (channels.rs:8-11).
- 이벤트 싱크(브로드캐스트, 패키지 수명)와 채널(유니캐스트, 호출 수명)의
  분리 이유 (channels.rs:17-21).
- 핸들 안전: 호스트별 단일 테이블, u32 단조 증가·재사용 없음, 해제된 핸들
  send 는 에러가 아니라 **무시(`Ok(false)`)** 원칙 (channels.rs:23-30).
- 전달 타입: JSON `ChannelSender = Arc<dyn Fn(&str)>`
  (channels.rs:41), 바이너리 `ChannelBytesSender = Arc<dyn Fn(&[u8])>`
  (channels.rs:48). **한 핸들은 한 경로로만 동작**(혼합 발송 미지원,
  channels.rs:43-48).

### 2.2 호스트 테이블 (channels_host.rs)

- 프로세스에 하나(`OnceLock`, channels_handles.rs:1-9의 `host()`).
- `next_handle: AtomicU64` — u32 공간 소진 시 0 을 exhaustion sentinel 로
  반환(되감김 방지, channels_host.rs:6-15).
- 발급 API: `register_channel`(1단계, :33-44), `reserve_handle`(선점,
  :51-54), `register_channel_with_handle`(2단계 — 콜백이 자기 핸들을 캡처해야
  하는 FFI/Tauri 경로용, :57-65). 바이너리 동일(:86-105).
- `send`/`send_bytes`: 테이블 부재 시 `false`, **호스트 콜백 패닉은
  catch_unwind 로 잡아 무시**(호출자 보호, :73-83, :109-122).
- `drop_channel`: JSON/바이너리 양쪽 테이블에서 제거(:125-139). 리소스
  테이블(`register_resource`/`drop_resource`, :142-168)도 동일 핸들 공간.
- 진단용 `counts()`(:171-183).

### 2.3 Rust 핸들러 표면 (channels_handles.rs)

- `ChannelHandle(pub u32)` — serde/schemars 표면은 plain u32
  (channels_handles.rs:15-18). `send(&str) -> bool` / `send_bytes(&[u8]) ->
bool`(:20-31). 만료 핸들은 `false`(stale 무시의 가시화 — 예제
  `ChannelDemoOutput.dropped_sends`, examples/calculator/src/lib.rs:967-989).
- 커맨드 인자로의 사용례: `channel_demo`(lib.rs:957-989, 동기 핸들러가 루프
  안에서 `input.channel.send`), `channel_demo_bytes`(:991-1027). 단위 테스트는
  `register_channel(Arc::new(closure))` 로 호스트를 흉내낸다(:1172-1207).
- 스키마 표현: `ChannelDemoInput.channel` 은 `allOf: [$ref
#/definitions/ChannelHandle]`, 정의 본체는 `{type: integer, format:
uint32, minimum: 0}` (examples/calculator/generated/schema.json, 명령
  `channelDemo`). TS 코드젠은 `export type ChannelHandle = number`
  (generated/types.ts:17) — 커맨드 와이어는 postcard varint 패스트패스
  유지(packages/cli/src/generate.test.ts:1084-1123).

### 2.4 FFI 표면 (ffi_channel.rs)

- C ABI 콜백 타입: `FfiChannelCallback = unsafe extern "C" fn(user_data,
handle, payload_cstr)`(:13-14), 바이너리 변형 `FfiChannelBytesCallback`
  (:20-25). 핸들이 콜백 인자로 **되돌아온다** — 호스트는 핸들→JS 콜백
  룩업만 하면 된다(:197-199).
- 발급: `rustra_ffi_channel_create` — reserve → 핸들을 캡처한 sink 등록
  2단계(:207-228). `rustra_ffi_channel_create_bytes`(:236-255).
- 송신: `rustra_ffi_channel_send`(:284-295), `rustra_ffi_channel_send_bytes`
  (:264-277).
- 해제: `rustra_ffi_channel_drop` — 호스트 테이블 제거 + sink
  **quiescence 대기**(`deactivate_and_wait` 는 in-flight 콜백이 모두 반환할
  때까지 Condvar 블록, :100-115, :303-321). **콜백 안에서 자기 핸들을 동기
  drop 하면 교착 — 금지**(Safety 문서, :206).

### 2.5 재사용 가능 결론

역방향 콜백의 "0회 이상 Rust→JS 호출" 채널 코어는 **그대로 재사용
가능**하다: 핸들 공간(단조 u32/무재사용), 호스트 단일 테이블, stale 무시,
패닉 격리, quiescence 해제. 신규 필요분은 §6 에서 식별한다.

## 3. 4호스트 채널 브릿지 비교

### 3.1 요약 매트릭스

| 축                     | Tauri                                                                  | Node (loop-stdio)                                                      | Bun (FFI)                                                     | RN (JSI)                                                                       |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 발급                   | `invoke('rustra_channel_create')` → `{handle}` (tauri-channels.ts:134) | 예약 프레임 0xfffb → `{handle}` (node-channels.ts:135)                 | `rustra_ffi_channel_create` 직접 (bun-channels.ts:118)        | `createChannel(cb)` HostFunction → handle (react-native-events.ts:28, cpp:518) |
| 수신 경로              | `listen('rustra://channel/{h}')` emit (tauri-channels.ts:148)          | stdout 0xfffc 프레임 → `onChannelFrame` (node-channels.ts:143)         | FFI 콜백(트램폴린 1개 + 핸들 Map, bun-channels.ts:94-114)     | FFI→큐 적재→CallInvoker drain→JS (cpp:552-565, 584-631)                        |
| 해제                   | `invoke('rustra_channel_drop')` + unlisten (:166-173)                  | 0xfffa + 구독 해지 (:163-169)                                          | `rustra_ffi_channel_drop` (동기, :129-135)                    | `dropChannel(handle)` (cpp:540-550)                                            |
| 백그라운드 스레드 send | 안전(emit 스레드 안전, tauri_support.rs:324-333)                       | **안전**(STDOUT_LOCK 임계구역, node-channels.ts:15-19)                 | **불가** — JS 스레드(동기 FFI 체인)만 (bun-channels.ts:12-20) | 안전(큐 적재만, cpp:554-565)                                                   |
| 백프레셔               | emit 내부 큐(계약 문서 없음 — 미확인)                                  | stdout 쓰기 블록(파이프), 유실은 write 에러 시 (loop_stdio.rs:179-187) | 없음(동기 호출 체인)                                          | **drop-oldest, capacity 1024** (cpp:558-560, 574-576; hpp:161)                 |
| 콜백 예외              | try/catch 없음 — Tauri 리스너로 전파 (tauri-channels.ts:148-157, §7.1) | `console.error` 격리 (node-channels.ts:153-158)                        | `console.error` 격리 (bun-channels.ts:107-110)                | C++ 에서 무시 (cpp:600-613)                                                    |
| double-close           | idempotent `true` (:167)                                               | idempotent `false` (:164)                                              | idempotent `false` (:130)                                     | idempotent `false` (react-native-events.ts:41)                                 |

### 3.2 Tauri

- Rust 측: `rustra_channel_create`/`rustra_channel_create_bytes`/
  `rustra_channel_drop` 커맨드(tauri_support.rs:71-95)가 핸들만 발급하고
  sender 는 `AppHandle`+핸들 캡처 emit 으로 고정 배선(:351-367, :401-419).
  `register` 의 invoke_handler 에 포함(:208-214).
- **근사 유니캐스트** — Tauri emit 은 브로드캐스트라 같은 채널명을 listen
  하는 다른 웹뷰가 프레임을 관측할 수 있다(tauri_support.rs:345-350,
  tauri-channels.ts:113-118).
- 바이너리 경로는 `Vec<u8>` 가 JSON 숫자 배열로 직렬화 — **~4배 와이어
  부풀림**(tauri_support.rs:386-394, tauri-channels.ts:226-231).
- 발급-리스닝 실패 시 정리 drop 보장(tauri-channels.ts:131-162).

### 3.3 Node (loop-stdio)

- 예약 cmd id: 발급 0xfffb(바이너리 모드 플래그 0x01), 해제 0xfffa, JSON
  푸시 0xfffc, 바이트 푸시 0xfff9(node-channels.ts:5-29,
  node-loop.ts:105-130). Rust 발급부는 examples/calculator/src/loop_stdio.rs
  (`issue_channel`:101-119, drop:136-138).
- 채널 프레임 쓰기는 STDOUT_LOCK 단일 임계구역 — **백그라운드 스레드 send
  도 안전**(node-channels.ts:15-19, loop_stdio.rs:160-187). Bun 과 대조되는
  핵심 차이.
- 바이너리 모드 전용 — NDJSON transport 에서 loud-fail(node-channels.ts:41-46),
  구 런타임 `channelBytes` capability 미에코 감지(:216-223).
- **루프는 단일 스레드 read-dispatch 루프**다(loop_stdio.rs:214-259): 프레임
  읽기 → 동기 dispatch → 응답 쓰기 → 다음 프레임. 핸들러가 실행 중이면
  다음 stdin 프레임(JS→Rust 요청)을 읽을 수 없다 — request/response 콜백의
  교착 원인(§6.2).

### 3.4 Bun

- `threadsafe: false` JSCallback — Bun 1.4 의 threadsafe 콜백은 인자
  마샬링이 불안정(1.4.0 실증, bun-channels.ts:12-15, bun-events.ts:19-26).
  따라서 콜백은 **JS 스레드에서만**, 즉 동기 FFI invoke 체인 안에서
  `ChannelHandle::send` 하는 핸들러가 전제(bun-channels.ts:15-17).
- 이벤트와 달리 채널에는 **폴링 폴백이 없다** — 채널은 버스에 적재되지
  않고 발급자 클로저를 직접 호출한다(bun-channels.ts:17-20,
  channels_host.rs:73-83). 백그라운드 send 가 필요한 호스트는 Node 루프
  푸시 프레임 설계를 기다려야 한다(같은 문서).
- close 는 `rustra_ffi_channel_drop` 동기 호출 — quiescence 블록 계약,
  콜백 안에서 close 금지(bun-channels.ts:24-27, 129-135).

### 3.5 RN (JSI)

- C++ `ChannelDispatcher`: FFI 콜백(send 스레드)은 **큐 적재만**, JS 스레드
  drain 이 콜백 호출(cpp:474-481, 552-565). 키가 이벤트 이름(브로드캐스트)이
  아니라 핸들(유니캐스트).
- **리로드 안전**: `setCallInvoker`/`reset()` 이 콜백 맵 정리와 함께 Rust 채널도
  drop — 귀속 채널은 리로드된 런타임에서 무의미(cpp:479-481, 493-511,
  633-646).
- 백프레셔: capacity 1024 drop-oldest(cpp:558-560, 575-576, hpp:161) —
  이벤트 버스 기본 용량 1024(builder_events.rs:3)와 동일 값.
- **CallInvoker 없는 호스트의 공백(중요 발견)**: 이벤트는
  `drainEvents()` JS 폴링 + `SubscribeOptions.pollMs` 폴백이 있다(commit
  731bbae9, react-native-events.ts:77-116). 그러나 `drainEvents` HostFunction은
  **EventDispatcher 만 drain 한다**(cpp:854-866) — ChannelDispatcher 는
  `scheduleDrainLocked` 가 `callInvoker_` 를 요구하고(cpp:616-618), JS 가
  채널 큐를 drain 할 수 있는 HostFunction은 없다. 즉 CallInvoker 없는 RN
  호스트에서 **채널 프레임은 영원히 소비되지 않는다**(이벤트의 731bbae9 이전
  상태와 동일한 구조적 결함). 역방향 콜백이 이 경로를 상속하면 안 된다.
- `invokeTypedAsync(name, args, onSuccess, onError)` — JS 함수 2개를 인자로
  받아 CallInvoker 로 결과를 마샬링하는 **이미 존재하는 역방향 콜백
  선례**(cpp:1239-1344). request/response 설계가 참고할 수 있는 패턴: 컨텍스트
  레지스트리 + generation 무효화 + shared_ptr 수명 보장.

### 3.6 EngineSupports 현황

`EngineSupports.channels: boolean`(packages/types/src/public.ts:27-34).
현재값: RN true(react-native-core.ts:57, 72), Tauri/Node/Bun 엔진 표면은
false(tauri/src/index.ts:118, node-core.ts:20, bun-ffi.ts:28, 45) — 채널이
엔진에 통합된 게 아니라 독립 어댑터 함수로 존재하기 때문. 콜백 capability는
이 불일치를 반복하지 않도록 설계에서 다룬다(design 문서 §D).

## 4. 취소/수명/실행자 제약

### 4.1 취소 레지스트리 (cancel.rs)

- `register_invocation`(u64 발급, :44-51) / `cancel_invocation`(플래그
  전환만, :53-67) / `complete_invocation`(:69-75) / `status`(:77-88).
  스레드 강제 종료 없음 — 협력적 취소(:1-12).

### 4.2 취소 체크포인트는 "dispatch 전" 1회뿐 (ffi_workers.rs)

- `run_worker`/`run_worker_into` 는 dispatch 직전에만 `status(id)` 를
  조회하고(ffi_workers.rs:46-53, 91-98) **체크포인트 통과 후 취소되면 핸들러는
  끝까지 실행**된다(:6-8). 핸들러 실행 중 취소가 콜백 경로를 정리할 수 있는
  훅은 현재 없다 — "커맨드 취소 시 콜백 자동 해제"는 JS 래퍼(pre-abort) 또는
  완료 시점 정리로만 구현 가능.
- `complete_invocation` 은 `on_complete` 이전 실행 보장(:15-18, 55-57).

### 4.3 async 풀 백프레셔 (ffi_pool.rs)

- 고정 2워커 + 큐 깊이 256, 초과 제출은 즉시 거부(:10-16, 94-117). 콜백
  대기(request/response)가 이 풀의 워커를 점유하면 전체 async 처리량이
  2워커로 수렴 — 타임아웃 없는 대기는 풀 고갈 위험.

### 4.4 실행자 제약 (executor.rs) — 콜백 대기 설계의 핵심 제약

- `block_on` 은 **현재 스레드 park 폴링**(executor.rs:37-48). 두 함의:
  (1) 핸들러가 풀 워커/FFI 스레드에서 실행 중일 때 JS 응답을 기다리며
  block_on 하면 그 스레드가 묶인다(async 핸들러의 spawn 태스크에서는
  State 가 안 보인다, :30-36, state.rs:11-13 thread_local).
- **동기 invoke 체인에서의 역재진입 금지**: JS 스레드가 동기 FFI/JSI 호출로
  Rust 핸들러를 실행 중이고, 핸들러가 JS 콜백 응답을 기다리면 — JS 는 그
  호출 안에 갇혀 콜백을 실행할 수 없어 **교착**. Bun 동기 경로(bun-channels.ts
  의 전제), RN `invokeTyped` 동기 경로, Node 단일 스레드 루프(loop_stdio.rs
  의 동기 dispatch) 모두 여기에 해당한다.

## 5. "커맨드 실행 중 콜백 호출"의 실현 경로 매핑

커맨드 핸들러가 실행 중 `ChannelHandle::send`(또는 그 후속)를 호출할 때,
각 호스트가 실제로 JS 콜백을 실행하는 메커니즘과 제약:

1. **Node** — 핸들러(동기 dispatch)가 0xfffc 프레임을 stdout 에 쓰면 JS 의
   stdout 데이터 이벤트로 도착. 단, 루프가 동기 dispatch 중이므로 **JS 가
   프레임을 관측하는 것은 커맨드 응답 수신 전후의 이벤트 루프 턴**이다. 즉
   콜백 실행은 커맨드 완료와 동시성을 가진다(핸들러가 이어서 더 보낸 프레임은
   순서만 보존). JS 턴이 필요하므로 **동기 request/response 불가**(§4.4).
2. **Tauri** — 핸들러가 `app.emit_str`(임의 스레드 안전,
   tauri_support.rs:324-333)하면 웹뷰의 listen 콜백이 JS 이벤트 루프에서
   실행. 커맨드는 별도 Tauri IPC 이므로 **JS 는 응답 대기 중에도 콜백을 실행할
   수 있다** — request/response가 구조적으로 가능한 유일한 범용 경로. 응답은
   JS 가 `rustra_callback_reply`류 커맨드(신규)를 invoke 하는 방식.
3. **Bun** — 동기 FFI 체인 안에서만 콜백 실행 가능(§3.4). JS 스레드가
   invoke 안에 있으므로 **콜백 실행 자체가 invoke 반환 후으로 지연되는 게
   아니라**, invoke 체인 안에서 Rust→JS 직접 호출(JSCallback)이 일어난다 —
   단방향은 가능, 대기는 불가.
4. **RN** — (a) 동기 `invokeTyped`: JSI 스레드가 호출 안에 있음 → 단방향은
   가능하나(콜백은 큐 적재 후 나중에 drain) **동기 응답 대기 불가**.
   (b) async `invokeTypedAsync`(워커 풀 + CallInvoker 결과 마샬링,
   cpp:1239-1344): JS 스레드가 자유롭다 — ChannelDispatcher 가 CallInvoker 로
   drain 하고(cpp:616-631), JS 가 응답을 invoke 로 되돌리는
   request/response가 가능. CallInvoker 없는 호스트는 §3.5 의 공백.

## 6. 격차 분석 — 채널 인프라로 커버되는 것 / 안 되는 것

### 6.1 커버됨 (재사용)

- 핸들 발급/해제/stale 무시/패닉 격리/quiescence(§2).
- 단방향 "핸들러 실행 중 Rust→JS 알림" 전달 파이프라인 4호스트 전부(§3,
  §5). 커맨드 인자로 u32 를 실는 와이어/스키마 패스트패스(§2.3).

### 6.2 안 커버됨 (신규 필요분)

1. **커맨드 스코프 수명** — 현재 채널은 명시 close. "커맨드 settle(성공/에러/
   pre-abort) 시 자동 drop" 래퍼와, 누수 방지 정리 경로(발급 실패/구독 실패
   정리는 tauri-channels.ts:131-162 가 선례)가 필요. Rust 코어는 "이 커맨드가
   어떤 콜백 핸들을 받았는지" 모른다 — 자동 해제 책임의 소재(호스트 래퍼 vs
   Rust 스코프 가드)가 설계 결정.
2. **페이로드 타입 계약** — 콜백 파라미터의 스키마/TS 함수 타입 발행.
   채널은 `unknown` 페이로드. 이벤트의 `.event::<E>(name)` 선언 패턴
   (builder_events.rs:62-82)이 참고 모델.
3. **request/response** — (a) 호출 프레임에 순번(seq) 부여, (b) Rust 측
   (handle, seq)→oneshot 대기 레지스트리, (c) JS→Rust 응답 경로(Tauri
   커맨드/RN HostFunction/Node 예약 프레임 — Node 는 단일 스레드 루프 재설계
   전 불가, §3.3·§4.4), (d) 타임아웃(무응답 방지 — 풀 점유 §4.3). 현재
   코어에 대응물 없음.
4. **콜백 예외 계약 통일** — 4호스트가 제각각(§3.1 표). request/response에서는
   예외가 "거부 응답"으로 역전파돼야 의미가 있다.
5. **호스트 capability 노출** — `EngineSupports` 에 콜백 수준(단방향/
   request-response/없음) 표면 부재(§3.6). 특히 "동기 경로에서의 역호출
   불가"는 Bun/Node/RN 동기 경로의 구조적 제약이므로 기계 판독 가능해야 한다.
6. **RN CallInvoker-less drain** — 채널/콜백 큐의 JS 폴링 경로 부재(§3.5).

## 7. 상호작용 세부

### 7.1 콜백(수신) 측 예외의 현재 처리

- Node: `console.error` 후 전달 경로 유지(node-channels.ts:153-158,
  243-246). Bun: 동일(bun-channels.ts:107-110). RN C++: 무시(cpp:600-613).
- Tauri: listen 핸들러가 사용자 콜백을 try/catch 없이 호출
  (tauri-channels.ts:148-157) — 예외는 Tauri 이벤트 리스너 경계로 간다(이후
  처리 미확인 — 문서화된 계약 없음). 불일치.
- 코어 원칙은 명확하다: "호출자를 죽이지 않는다"(channels.rs:38-40,
  channels_host.rs:70-72). 콜백 표면에서 이 원칙의 구현을 통일해야 한다.

### 7.2 취소와 콜백

- pre-abort(JS 프라미스 거부, Rust 실행 계속 가능 — public.ts:84-93의 얕은
  취소 경고): 콜백 핸들은 이미 발급돼 있을 수 있다. JS 래퍼의 settle 정리가
  유일한 회수 경로(§4.2 — Rust 측 실행 중 정리 훅 없음).
- 취소 후 stale send 는 `false` 무시(§2.1) — 핸들 단조 증가·무재사용 덕분에
  이후 발급 핸들과 충돌하지 않는다(channels.rs:25-30).

## 8. 경쟁자 참고 포인트 (2차 출처 — 상세 미확인)

- UniFFI callback_interface, Nitro 반환값 있는 콜백: 격차 #4 정의에서 언급된
  대상(competitive-landscape.md:43). 반환값 있는 JS/Rust 경계 함수를 계약의
  일급 시민으로 코드젠한다 — 이 트랙의 목표 상태.
- Tauri v2 `ipc::Channel`: rustra 채널의 원형(channels.rs:1). 커맨드 인자로
  채널을 넘기면 완료 시 자동 정리된다는 사용 패턴 문서가 있으리라 추정되나
  미확인 — 본 설계는 rustra 코드 사실에만 근거한다.

## 9. YAGNI 경계 (조사 확정분)

이 트랙이 하지 않을 것 — 근거와 함께:

1. **커맨드 밖 수명의 콜백** — 그 용도는 이미 채널(명시 open/close)이 담당
   (§1). 콜백은 커맨드 스코프로 한정한다.
2. **한 콜백에 다중 리스너** — 유니캐스트 계약(channels.rs:17-21) 유지.
   브로드캐스트는 이벤트.
3. **콜백 우선순위/병렬 순서 변경** — 현재 각 호스트 전달 큐는 핸들별
   FIFO 다(RN deque swap 후 순차 전달, cpp:584-614; Node/Tauri/Bun 은 단일
   경로 순서 보존). 이 이상의 스케줄링 표면은 요구 근거 없음.
4. **백프레셔 튜닝 API** — RN capacity 1024 고정값이 이벤트 버스와 동일
   (§3.5). 오버로드 계측(ffi_pool.rs:119-140의 A08 패턴)으로 근거를 모은 뒤.
5. **콜백의 바이너리 페이로드** — 채널 bytes 경로가 이미 존재(§2.1).
   콜백 트랙은 JSON 경로만 먼저(설계 문서에서 확정).
6. **JS 가 임의 시점에 Rust 를 호출하는 "서비스로서의 콜백"** — 그것은
   커맨드의 정의다. 이 트랙은 커맨드 인자 스코프만.

## 10. 오픈 질문 (설계로 넘김)

1. request/response의 기본 타임아웃 정책(필수 여부, 기본값, 에러 코드).
2. Node 에서 request/response 를 위한 루프 재설계(대기 중 교차 읽기)를
   이 트랙에 포함할 것인가, capability 미지원으로 둘 것인가.
3. Tauri 근사 유니캐스트(§3.2)를 콜백에 그대로 쓸지 — 시퀀스 검증 등 추가
   강화 여부.
4. `CallbackHandle` 의 핸들 테이블 — ChannelHost 단일 테이블 공유 vs 별도
   테이블(공간 고갈·진단 분리).
5. 콜백 자동 해제의 책임 소재 — JS 래퍼(settle 후 drop) 단일인가, Rust 코어의
   invocation 연계 가드도 둘 것인가(§6.2-1).
6. RN CallInvoker-less 호스트의 채널/콜백 drain 경로(§3.5) — 이 트랙에서
   `drainEvents` 확장으로 같이 고칠 것인가.
7. 스키마에서 콜백 파라미터의 표현 — ChannelHandle 스타일 newtype 정의를
   어떻게 TS 함수 타입으로 렌더링할지(§2.3의 검출 방식과의 정합).

## 11. 결론

채널 코어(핸들·테이블·전달·해제)는 역방향 콜백의 하부 구조로 그대로
재사용 가능하다. 신규 필요분은 (1) 커맨드 스코프 수명 자동화, (2) 페이로드
타입 계약(스키마→TS 함수 타입), (3) request/response의 seq·대기·응답
경로·타임아웃, (4) 예외/취소 계약 통일, (5) capability 노출, (6) RN
CallInvoker-less drain 공백 메움으로 특정됐다. request/response는 호스트별
가용성이 갈린다(Tauri=가능, RN async=가능, Bun/Node 동기·RN 동기=구조적
교착) — 이 분기가 설계의 capability 매트릭스가 된다.
