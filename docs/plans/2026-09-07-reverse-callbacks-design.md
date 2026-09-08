# 역방향 콜백 — 설계 (2026-09-07)

상태: 설계 확정(구현 계획은 별도 문서). 경쟁 격차 #4(반환값 있는 JS 함수,
`docs/research/2026-09-07-competitive-landscape.md:43`)를 해소하고, 직전
트랙이 착지한 채널 인프라(같은 문서 `:117-120`)를 재사용한다. 사실 근거는
`docs/research/2026-09-07-reverse-callbacks.md`(이하 "리서치 문서") — 이
문서는 근거 재인용을 최소화하고 결정만 적는다.

## 문제

커맨드 실행 중 Rust 가 JS 측 함수를 호출하는 표면이 없다. 오늘날 가장 가까운
것은 채널이지만(리서치 §1):

1. **수명이 수동이다** — JS 가 `createChannel()` 후 `close()` 를 직접
   호출해야 한다(tauri-channels.ts:119-124). 커맨드 완료·에러·취소 시 자동
   정리가 없어 누수 여지가 항상 남는다.
2. **페이로드가 무타입이다** — 채널 콜백은 `unknown`/`Uint8Array`
   (node-channels.ts:58). 커맨드 계약(스키마→코드젠)의 일부가 아니다.
3. **JS 함수의 반환값을 Rust 로 받을 수 없다** — `ChannelHandle::send` 는
   도달 bool 만 반환(channels_handles.rs:21-30). UniFFI callback_interface·
   Nitro 와의 격차 본체(격차 #4).
4. **호스트별 예외·백프레셔 계약이 제각각이다** — 예외 처리 4호스트 4색,
   Tauri 는 무방비(리서치 §3.1, §7.1).

## 설계

### 개요 결정 5줄

1. **`CallbackHandle` 신규 타입** — 채널 코어(`ChannelHost` 테이블·핸들
   공간·전달 계약)를 그대로 재사용하되, 수명(커맨드 스코프 자동 해제)과
   TS 표면(함수 타입)이 다른 별도 newtype.
2. **JS 표면은 "함수를 그냥 인자로 넘긴다"** — 코드젠 클라이언트가 함수
   인자를 감지해 발급→배선→invoke→settle 후 자동 drop 한다.
3. **단방향(call) 먼저, request/response(call_wait)는 capability 로
   단계 착지** — 동기 경로 교착(리서치 §4.4) 때문에 호스트별 가용성이
   갈린다: Tauri/RN-async 가능, Bun/Node/RN-동기 불가.
4. **EngineSupports.callbacks 확장** — `'none' | 'one-way' |
'request-response'` 3단계로 기계 판독(기존 `channels: boolean` 은 수동
   스트림용으로 유지).
5. **호출 순서는 핸들별 FIFO, 단방향은 최선형 전달, request/response 는
   필수 타임아웃** — Rust 실행을 절대 블록하지 않는 채널 원칙 유지.

### A. 계약 — Rust 표면과 스키마

#### A.1 `CallbackHandle` newtype (crates/rustra/src/channels_handles.rs)

```rust
/// 커맨드 인자용 콜백 핸들 — wire 는 ChannelHandle 과 동일한 plain u32.
/// 차이는 수명(커맨드 스코프 자동 해제)과 TS 표면(함수 타입)뿐이다.
pub struct CallbackHandle(pub u32);

impl CallbackHandle {
    /// 단방향 호출 — 페이로드 JSON을 JS 콜백에 전달. 만료 핸들은 false(무시).
    pub fn call(&self, payload: &str) -> bool;
    /// request/response 호출 — JS 반환값을 timeout 내 수령. (capability 호스트만)
    pub fn call_wait(&self, payload: &str, timeout: Duration) -> Result<String, CallbackError>;
}
```

- **ChannelHost 단일 테이블·핸들 공간 공유** — 별도 테이블을 만들지 않는다.
  단조 u32·무재사용·stale 무시·패닉 격리·quiescence(channels_host.rs 전반)를
  그대로 상속한다. 채널과 콜백을 한 테이블에서 구분할 필요가 없는 이유:
  구분 정보는 JS 래퍼와 코드젠이 소유하고, 코어는 "u32 → sender" 만 알면
  된다(리서치 오픈 질문 4 종결 — 진단 분리가 필요해지면 그때 분리).
- `call_wait` 반환은 **JSON 문자열** — 채널 페이로드 인코딩(JSON 문자열,
  channels.rs:38-40)과 동일 규약. rkyv V2 프레임 등 바이너리 반환은 YAGNI
  (리서치 §9-5).

#### A.2 선언 표면 (빌더/스키마)

이벤트 선언 패턴(builder_events.rs:62-82 — `.event::<E>(name)` → schema
`events` 섹션 → TS 구독 헬퍼)을 커맨드 입력에 적용한다:

```rust
// 커맨드 입력 구조체 — 콜백 필드는 제네릭 마커로 페이로드 타입을 계약에 싣는다.
pub struct LongTaskInput {
    pub on_progress: CallbackHandleOf<ProgressPayload>,  // wire u32, 스키마에 payload ref
    pub on_chunk:     CallbackHandleOf<ChunkPayload>,     // 콜백 2개 이상도 허용
    pub ticks: i32,
}

#[command]
fn long_task(input: LongTaskInput) -> Result<LongTaskOutput> {
    for step in 0..input.ticks {
        input.on_progress.call(&serde_json::to_string(&ProgressPayload { step })?)?;
    }
    ...
}
```

- **wire**: `CallbackHandleOf<P>` 의 serde/schemars 표면은 plain u32 —
  ChannelHandle 과 동일하게 `single-entry allOf newtype` 이 postcard varint
  패스트패스에 남는다(generate.test.ts:1084-1123 실증 계약).
- **스키마**: 정의는 `CallbackHandleOf` + `payload` 서브스키마 참조 2개로
  발행된다(정확한 schemars 인코딩은 구현 슬라이스에서 확정 — 오픈 질문
  7). 요점은 **정의 이름만으로 TS 렌더러가 함수 타입을 발행할 수 있어야
  한다**는 계약이다.
- **TS 렌더링**: 입력의 해당 필드는 `(payload: ProgressPayload) => void`
  (단방향) 또는 `(payload: P) => R | Promise<R>`(request/response) 로
  발행. `R` 도 스키마에 선언된 경우에만 request/response 타입이 된다.
- **정당화(거절한 대안)**:
  - _채널 재사용(`ChannelHandle` 그대로)_ — 수명·표면 계약이 달라 타입으로
    구분되지 않으면 자동 해제·함수 인자 설탕을 안전하게 넣을 수 없다.
  - _별도 최상위 `callbacks` 스키마 섹션_ — 콜백은 커맨드 인자이므로 입력
    스키마 안에 있어야 계약 해시·드리프트 게이트가 자동 커버한다. 이벤트처럼
    독립 섹션을 만들면 커맨드와 콜백의 대응이 약해진다.
  - _호출 서명에 콜백을 직접(함수 포인터) 싣기_ — wire 에 함수를 실을 수
    없다는 채널 설계 원칙(channels.rs:5-15) 위반. 정수 핸들만 실는다.

### B. 수명 — 커맨드 스코프 자동 해제

**결정: 자동 해제가 계약, 명시 해제는 없음.** 책임 배분:

- **JS 래퍼(코드젠 클라이언트)가 유일한 발급·해제 주체**:
  1. 함수 인자를 감지하면 호스트 어댑터로 핸들 발급+배선(콜백 인자당 1회).
  2. 커맨드 invoke.
  3. **settle(성공/거부/pre-abort) 후** 발급한 핸들을 drop(finally 계열).
  4. 발급 or 배선 실패 시 즉시 drop(타우리 어댑터의 정리 패턴 선례,
     tauri-channels.ts:131-162).
- **Rust 코어는 invocation 연계 가드를 만들지 않는다.** 이유: (a) 코어는
  커맨드가 어떤 핸들을 받았는지 모르고 동적 커맨드에서 추적 비용이 크다.
  (b) settle 시점에 JS 래퍼가 즉시 drop 하므로 정상 경로 누수가 없다.
  (c) 이탈 경로(JS 즉사, 래퍼 우회)는 호스트 수명 정리가 이미 담당한다 —
  RN 리로드 시 ChannelDispatcher 가 귀속 채널 전부를 Rust drop
  (cpp:493-511, 633-646), Node 는 자식 프로세스 종료, Tauri 는 앱 수명.
  (d) Rust 측 실행 중 취소 정리 훅은 애초에 없다 — 취소 체크포인트는
  dispatch 전 1회뿐(ffi_workers.rs:46-53).
- 콜백이 커맨드보다 오래 살아야 하는 사용례는 **채널**(명시 open/close)이
  담당 — 두 표면의 역할 분담을 문서 계약으로 못박는다(리서치 §1).

**request/response와의 정합**: `call_wait` 의 대기 중 목록은 핸들별
(seq, oneshot) 레지스트리에 산다. 커맨드가 settle 되면 핸들러도 끝났으므로
대기 중 목록은 비어 있다. 이탈 순서 방어로, drop_channel 시 해당 핸들의
미회신 entry 를 즉시 실패 처리(`callback.cancelled`)한다.

### C. JS 표면 — 함수 인자 설탕

```ts
// 사용자가 쓰는 모습 (코드젠 결과):
const out = await longTask({ ticks: 3, onProgress: (p) => setBar(p.step) });
// onProgress: (payload: ProgressPayload) => void — 래퍼가 발급/배선/자동 해제.
```

- 코드젠 클라이언트는 함수 인자를 호스트 어댑터의 `createCallback(fn)` 으로
  교체하고 `handle` 숫자를 실제 와이어 인자로 넣는다. 어댑터별 구현은
  **기존 채널 어댑터의 발급/수신/해제 계약을 그대로** 따른다(Tauri
  createChannel, Node `__createChannel`, Bun FFI, RN `createChannel`).
- **단방향 콜백 예외 정책 통일(신규 계약)**: 사용자 함수가 던지면
  (a) 단방향 — 어댑터가 격리하고 debug 싱크로 관측(tauri-channels.ts의
  `observeBytesPayloadError` 패턴, :203-213). Node/Bun 의 console.error
  관행을 이 디버그 싱크 경로로 수렴시킨다. (b) request/response — 예외는
  **거부 응답**으로 변환돼 Rust `call_wait` 가 `Err(CallbackError::js)` 로
  받는다. 코어 원칙 "호출자를 죽이지 않는다"(channels.rs:38-40) 유지.
- **호출 순서**: 핸들별 FIFO 보장. 근거: 전달 경로가 이미 FIFO 다(RN deque
  순차 drain cpp:584-614, Node/Tauri/Bun 단일 경로 순서 보존 — 리서치
  §3). 코드젠은 한 콜백 핸들의 `call` 순서가 JS 도착 순서와 일치함을 계약
  문서로 명시한다. **서로 다른 콜백 핸들 간의 순서는 보장하지 않는다**
  (멀티호스트·멀티스레드 전달에서 약속 불가).

### D. 호스트 capability 매트릭스와 EngineSupports 확장

#### D.1 `EngineSupports.callbacks`(packages/types/src/public.ts 확장)

```ts
export type EngineSupports = {
  ...
  channels: boolean;                      // 기존 — 수동 수명 스트림 (변경 없음)
  /** 역방향 콜백 수준 (격차 #4). */
  callbacks: 'none' | 'one-way' | 'request-response';
};
```

- additive 필드 — 옵셔널하지 않고 파티 어댑터가 채운다(기존 `channels` 와
  동일 관례). 타사 엔진 호환은 `supports?` 자체가 옵셔널(public.ts:38-40)이라
  유지된다.

#### D.2 호스트별 지원 수준 (결정)

| 호스트                         | 단방향                                           | request/response                                                                | 근거                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri                          | 지원                                             | **지원** — emit 으로 호출, `rustra_callback_reply` 커맨드로 응답                | 커맨드가 별도 IPC 스레드 — JS 가 응답 대기 중에도 콜백 실행 가능(리서치 §5-2). emit 스레드 안전(tauri_support.rs:324-333). 근사 유니캐스트 한계는 채널과 동일(:345-350) — 시퀀스 검증으로 보강(§E). |
| Node (loop-stdio)              | 지원                                             | **미지원(구조적)**                                                              | 단일 스레드 read-dispatch 루프(loop_stdio.rs:214-259) — 핸들러 대기 중 JS→Rust 응답 프레임을 읽을 수 없어 교착. 해소는 루프 재설계(대기 중 교차 읽기)가 필요 — 별도 트랙(오픈 질문 2).              |
| Bun                            | 지원 — 단, **동기 FFI 체인 안의 핸들러만**       | **미지원(구조적)**                                                              | threadsafe:false 계약(bun-channels.ts:12-20) — JS 스레드가 invoke 안에 있으므로 응답 대기 불가. `call_wait` 사용 시 컴파일은 되고 런타임 `callback.timeout`으로 드러난다(§F).                       |
| RN (async 경로)                | 지원                                             | **지원** — CallInvoker drain + `callbackReply(handle, seq, value)` HostFunction | JS 스레드가 자유로운 async 경로(invokeTypedAsync 선례, cpp:1239-1344).                                                                                                                              |
| RN (동기 invokeTypedSync 경로) | 지원                                             | 미지원                                                                          | JSI 스레드가 동기 호출 안에 있음(리서치 §5-4a).                                                                                                                                                     |
| RN CallInvoker-less 호스트     | **미지원** → 이 트랙에서 drain 경로 추가 시 지원 | 미지원                                                                          | 현재 채널 큐에 JS 폴링 drain 이 없다(cpp:616-618, 854-866 — 이벤트만 drain). §G 슬라이스에서 `drainEvents`가 ChannelDispatcher 도 drain 하도록 확정.                                                |

- 어댑터별 `supports.callbacks` 초기값은 **정적 상수로 고정**한다(런타임
  감지 분기 없음): Tauri `'request-response'`, Node `'one-way'`, Bun
  `'one-way'`, RN `'request-response'`. 이유: CallInvoker 유무 같은 런타임
  조건으로 값을 강등하는 판정은 복잡도 대비 이득이 없다. RN CallInvoker-less
  호스트의 콜백 미도달은 §G 슬라이스 2(drain 폴백)가 폐쇄하므로, 폴백
  착지 뒤에는 정적 값이 실제와 일치한다.

#### D.3 request/response 와이어 (capability 호스트만)

- **호출 프레임**(Rust→JS, 기존 채널 JSON 프레임의 확장): `{"handle": u32,
"seq": u64, "payload": <JSON>, "expectsReply": true}` — `seq` 는 핸들별
  단조 증가. 단방향 `call` 은 `expectsReply` 없는 기존 형태 그대로(하위
  호환).
- **응답 경로**(JS→Rust, 호스트별):
  - Tauri: 신규 커맨드 `rustra_callback_reply { handle, seq, ok, value }` —
    `rustra_dispatch` 계열의 동일 등록 지점(tauri_support.rs:208-214)에
    추가.
  - RN: 신규 HostFunction `callbackReply(handle, seq, ok, valueJson)` —
    `createChannel`/`dropChannel` 과 같은 캐시 블록(cpp:870-930)에 추가.
  - Rust 코어: `(handle, seq) → oneshot` 대기 레지스트리 + 타임아웃. 완료
    or drop 시 entry 제거(누수 방지는 cancel.rs 레지스트리의
    `complete_invocation` 관행 준용, cancel.rs:69-75).
- **교착 방지 원칙(문서 계약)**: `call_wait` 는 (a) Tauri 커맨드 스레드,
  (b) RN async 워커(ffi_pool 2워커, ffi_pool.rs:13)에서만 호출 가능. 워커
  점유 완화를 위해 **타임아웃은 필수 인자**(기본값 없음)로 강제한다 — 무한
  대기는 풀 고갈(ffi_pool.rs:10-16)로 이어진다.

### E. 에러·취소 상호작용

- **신규 에러 코드**(errors.ts `RustraErrorCode` 확장, 와이어 additive):
  - `callback.unavailable` — 호스트가 콜백 발급 불가(채널
    `channel.unavailable` 과 동일 철학의 loud-fail, errors.ts:187).
  - `callback.timeout` — `call_wait` 타임아웃(retryable 아님 — JS 가 늦게
    응답한 결과는 폐기).
  - `callback.error` — JS 콜백이 예외로 거부(request/response).
  - `callback.cancelled` — 핸들 drop 후 미회신 entry 의 실패 회수(§B).
- **JS 콜백 예외**: §C 정책(단방향 격리+관측, request/response 거부 응답).
- **커맨드 취소**: pre-abort(JS 프라미스 거부) 시 래퍼가 settle 정리로 핸들
  drop — 이후 Rust 의 stale send 는 `false` 무시(채널 stale 계약
  channels.rs:25-30). Rust 실행 중 취소는 존재하지 않는다(체크포인트가
  dispatch 전뿐 — ffi_workers.rs:6-8)이므로 "취소 중 콜백 경로 정리"의
  전부는 settle-drop 이다.
- **Bun `call_wait` 오용 방지**: capability 미지원 호스트에서의 `call_wait` 는
  즉시 실패가 아니라 timeout 만료까지 블록할 수 있다(교착은 아니고 타임아웃
  후 해소 — JS 스레드가 invoke 에서 풀려난 뒤에도 응답 경로가 없으므로).
  Rust 빌더 수준에서 방어할 수 없는 이유: 호스트 종속 정보를 코어가 모른다.
  계약 문서 + `EngineSupports.callbacks` 분기로 앱이 사전 판정한다.

### F. 백프레셔 정책

- **단방향 `call`**: 절대 Rust 를 블록하지 않는다(채널 원칙). 호스트별
  전달 특성은 현행 유지 — RN drop-oldest capacity 1024(cpp:558-576,
  hpp:161), Node stdout 블록(파이프), Tauri/Bun 논블록. 유실 관측은 채널의
  `dropped_sends` 관행(lib.rs:967-989)대로 커맨드 출력으로 가시화하는 사용
  패턴을 문서화한다(코어 변경 없음).
- **request/response `call_wait`**: 대기 상한=타임아웃(필수). 동시 미회신
  상한은 두지 않는다 — 등록 entry 는 타임아웃이 자동 회수하므로 상태 누수가
  없고, 워커 점유는 2워커 풀의 자연 상한(ffi_pool.rs:13)에 묶인다. 필요성
  증빙(측정 근거) 없이 새 크기 튜닝 표면을 만들지 않는다(A08 원칙 준용,
  ffi_pool.rs:119-129).
- **호출 빈도 조절(콜백 throttle/coalesce)**: YAGNI — 핸들러 작성자의 몫.

### G. 권장 슬라이스 순서 (구현 계획은 별도 문서)

1. **슬라이스 1 — 코어 계약 + 단방향 4호스트**: `CallbackHandle`/`call`
   (channels_handles.rs), `CallbackHandleOf<P>` 스키마/TS 함수 타입 렌더링,
   코드젠 클라이언트 설탕(발급/배선/settle-drop), `EngineSupports.callbacks`
   필드 + 4어댑터 값, 예외 정책 통일(debug 싱크). 계산기 예제
   `long_task_demo`(커맨드 인자 콜백 2개 — 진행률+청크)로 e2e 패리티
   검증(channel_demo 관례 준용, lib.rs:957-1027).
2. **슬라이스 2 — RN CallInvoker-less drain 폐쇄**: `drainEvents` 가
   ChannelDispatcher 큐도 drain(사전 발견 공백, 리서치 §3.5) + 채널/콜백
   `pollMs` 폴백. 이 트랙의 정당성: 콜백이 이 결함을 상속하지 않도록.
3. **슬라이스 3 — request/response(Tauri)**: seq 프레임 확장, (handle, seq)
   oneshot 레지스트리, `rustra_callback_reply` 커맨드, `call_wait` + 신규
   에러 코드, 타임아웃 필수 계약.
4. **슬라이스 4 — request/response(RN async)**: `callbackReply` HostFunction,
   async 워커 대기, reload 안전(entry 회수 — ChannelDispatcher reset 패턴
   준용 cpp:633-646).
5. **슬라이스 5 — 문서·매트릭스**: compatibility-matrix 셀 갱신, 채널 vs
   콜백 vs 이벤트 역할 분담 가이드, `callbacks` capability 표.

Node request-response(루프 교차 읽기 재설계)와 Bun 개선은 이 트랙 범위
밖(오픈 질문 2).

### H. YAGNI 명시

리서치 §9 를 설계로 확정: (1) 커맨드 밖 수명 콜백 — 채널이 담당, (2) 다중
리스너 — 유니캐스트 유지, (3) 우선순위/병렬 순서 API — 없음, (4) 백프레셔
튜닝 표면 — 측정 근거 후, (5) 콜백 바이너리 페이로드 — JSON 경로 먼저(채널
bytes 경로가 이미 존재), (6) 서비스로서의 콜백(커맨드 밖 등록) — 커맨드가
이미 답한다. 추가로: (7) 콜백 반환값의 스트리밍(제네레이터) — 없음, 회신은
1회 값.

## 남는 일 (이 설계의 범위 밖)

- Node loop-stdio의 대기 중 교차 읽기(또는 워커 dispatch)재설계 — Node
  request-response의 전제.
- Bun threadsafe JSCallback 재평가(Bun 상위 버전 마샬링 안정화 시) — 백그라운드
  send·request-response의 전제.
- 콜백 페이로드의 rkyv V2 바이너리 경로(채널 bytes 변형 준용).
- `EngineSupports.channels`(수동 스트림)의 어댑터별 false 값 정합(현재 RN 만
  true, 리서치 §3.6) — 독립 정리 항목.

## 하위 호환성

- `CallbackHandle`/`CallbackHandleOf` 는 신규 타입·신규 스키마 정의 — 기존
  패키지의 계약 해시·와이어 불변(스키마에 콜백 필드가 추가될 때만 해시가
  바뀌는 것은 정상 진화).
- 채널 프레임 형식 변경 없음 — request/response의 `seq`/`expectsReply` 는
  **새 프레임 변형**(단방향 형태와 공존)이며, 기존 단방향 프레임 수신자는
  변형을 몰라도 영향 없다(미확인 필드는 JS 수신부가 이미 unknown 관용으로
  처리하는 경계와 동일 설계).
- `EngineSupports.callbacks` 는 additive 필드. 신규 에러 코드 4종도 additive.
- 기존 채널 어댑터 API(createChannel/close)는 변경 없음 — 콜백 설탕은 그
  위의 레이어.
