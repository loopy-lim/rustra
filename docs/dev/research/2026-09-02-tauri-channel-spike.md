# Tauri 채널 어댑터 스파이크 — 0.6 포함/이월 판정

- 날짜: 2026-09-02
- 범위: `docs/plans/2026-09-01-roadmap-0.6.md` Task 10 (stretch) — 연구 스파이크, 프로덕션 코드 변경 없음
- 판정 기준(계획문 그대로): (a) 신규 FFI/코어 변경 불필요, (b) JS 콜백 라우팅이 기존 invoke 큐로 해결 — **둘 다** 충족 시 0.6 착지 시도, 아니면 0.7 이월

## 질문

Tauri 어댑터가 rustra 채널 표면(`channels.rs` ChannelHost + 코드젠 핸들 전달)을 webview IPC invoke 로 래핑할 수 있는가 — 채널 커맨드가 기존 `rustra_dispatch` invoke 경로로 흐를 수 있는가, JS 콜백 ↔ 채널 회신 라우팅이 `subscribeEvent` 없이 기존 invoke 큐만으로 해결되는가?

## 현재 표면 (사실)

### 채널 코어

- `crates/rustra/src/channels.rs:41` — `ChannelSender = Arc<dyn Fn(&str) + Send + Sync>`. 채널 계약 문서(channels.rs:1-30)는 채널을 **호출 귀속 유니캐스트 회신**(단일 호출자, 호출 수명 주기)으로 정의하고, 이벤트(`Package::emit` 브로드캐스트)와 별개 타입으로 둔다(channels.rs:17-21).
- 닫힌/만료 핸들로의 send 는 조용한 에러가 아니라 **무시**다 — `ChannelHost::send` 가 `false` 를 돌려주고 호출자가 판단한다 (`crates/rustra/src/channels_host.rs:70-80`, 계약 문 channels.rs:26-30).
- 호스트 API: `register_channel`(channels_host.rs:30) / `reserve_handle` + `register_channel_with_handle`(channels_host.rs:48, 54) / `send`(channels_host.rs:70) / `drop_channel`(channels_host.rs:83).
- 핸들 공간은 프로세스 전역 단일 테이블이다 — `crates/rustra/src/channels_handles.rs:1-9` (`OnceLock<ChannelHost>` 싱글턴 `host()`).
- `ChannelHandle(pub u32)` — serde 표면은 plain u32, `.send(&str) -> bool` 메서드만 첨부 (channels_handles.rs:18-25). wire 변화 없음.

### 오늘 채널을 쓰는 호스트는 RN JSI 하나뿐이다

호스트·호스트 바인딩 기준으로 `register_channel`/`ChannelSender` 호출부를 찾으면 세 곳뿐이다(이 외 호출부는 코어 자체 단위 테스트 `crates/rustra/src/channels_tests.rs:9,23,44,46,57,59` 가 전부다):

1. **FFI 엔트리** — `crates/rustra/src/ffi_channel.rs:115-135` (`rustra_ffi_channel_create`), `:143` (`rustra_ffi_channel_send`), `:162` (`rustra_ffi_channel_drop`). C++ JSI 호스트 전용.
2. **RN JSI 브릿지** — `packages/react-native/native/cpp/RustraJSIBridge.cpp:442` (FFI create 호출), `:763-797` (`createChannel`/`dropChannel` host function). TS 래퍼는 `packages/react-native/src/react-native-events.ts:13-40`.
3. **Rust 단위 테스트** — `examples/calculator/src/lib.rs:1733, 1758`.

**컨트롤러 전제 정정 1 — Node/Bun 루프 런타임은 채널을 만들지 않는다.** `examples/calculator/src/loop_stdio.rs`(196줄)에는 채널 참조가 0건이고, `packages/node`·`packages/bun` 어디에도 `createChannel` 이 없다. `node-loop.ts:65-80` 의 `0xfffe`(drain)/`0xfffd`(push) 예약 프레임은 **이벤트**(버스 브로드캐스트) 전달용이지 채널이 아니다 (`loop_stdio.rs:18-23` — 문서 주석도 "이벤트 drain/push"로만 기술). 즉 채널의 유일한 실동선 호스트는 JSI 다.

**컨트롤러 전제 정정 2 — "코드젠 read/write/close 채널 커맨드"는 존재하지 않는다.** `resource_open/read/write/close` 는 `examples/calculator/src/lib.rs:1637, 1661, 1689, 1713` 의 **리소스** 커맨드다. 채널의 생성/해제는 코드젠 커맨드가 아니라 호스트 런타임 수준(JSI host function, FFI 함수)이다. 코드젠이 채널에 기여하는 것은 u32 핸들 통과뿐 — `examples/calculator/generated/types.ts:17` (`export type ChannelHandle = number`), `commands.ts:29` (`channelDemo` 가 `channel: ChannelHandle` 인자를 일반 필드로 등록).

### Tauri 어댑터 오늘

- `crates/rustra/src/tauri_support.rs:39-48` — `rustra_dispatch` 는 상태 없는 `package.invoke_json(&command, args)` 래퍼다. 채널 인지(check) 로직 전무 — 임의 u32 인자는 그대로 JSON 으로 흘러간다.
- 이벤트 푸시는 별도 경로다 — `register_with_events`(tauri_support.rs:191-205)가 플러그인 setup 훅에서 `tauri_event_sink(app)`(tauri_support.rs:227-234)를 설치해 `Package::emit` → `app.emit_str("rustra://{sanitized}", payload)` 로 전달하고, JS 는 `subscribeEvent`(packages/tauri/src/tauri-events.ts:49-83)로 `listen` 한다.
- JS 엔진은 상태 없는 래퍼다 — `createTauriEngine`(packages/tauri/src/index.ts:111-138)이 모든 커맨드를 `tauriInvoke('rustra_dispatch', { command, args })` 로 라우팅한다.
- 예제 앱은 `register_with_events` 를 쓴다(`examples/tauri-calculator/src-tauri/src/main.rs:18`) — 채널 배선은 없다.
- 계산기 패키지의 `channel_demo`(examples/calculator/src/lib.rs:1600-1615)는 **이미** `rustra_dispatch` 로 도달 가능하다: 웹뷰에서 `invoke('rustra_dispatch', { command: 'channelDemo', args: { channel: <u32>, ticks: 3 } })` 를 오늘 호출하면 실행된다. 다만 발급자가 없는 핸들이므로 `sent=0, droppedSends=ticks` 로 끝난다 — 빠진 것은 커맨드 경로가 아니라 **콜백 다리**(발급자 배선) 하나뿐이다.

## 경로 분석

### (a) 신규 FFI/코어 변경 불필요한가? — 조건부 충족

**Rust→JS send 방향은 코어 변경 0건으로 흐른다.** `ChannelHost` 와 `ChannelHandle::send` 는 공개 API고(channels_handles.rs:7), 핸들은 wire 에서 plain u32라 `invoke_json`/`rustra_dispatch` 가 무수정으로 통과시킨다. 그리고 배선 패턴은 이미 증명돼 있다 — `tauri_event_sink`(tauri_support.rs:227-234)가 `AppHandle` 을 `Arc` 클로저로 캡처해 싱크로 설치하는 것과 완전히 동일한 방법으로, 채널 sender 도 `host().register_channel(Arc::new(move |payload| app.emit_str(...)))` 로 설치할 수 있다. 코어(channels.rs/channels_host.rs/ffi_channel.rs/dispatch/wire)는 한 줄도 건드리지 않는다.

**필요한 변경은 tauri_support.rs (어댑터 모듈) 안이다.** JS→Rust 방향, 즉 "웹뷰가 채널을 발급"받으려면 sender 클로저를 Rust 쪽에서 등록해야 하는데 이는 invoke 로는 표현할 수 없다(Tauri IPC 는 함수 값을 실어 보낼 수 없다). 최소 경로는 `tauri_support.rs` 에 `#[tauri::command] rustra_channel_create/drop` 두 개를 추가하는 것 — `tauri` feature 게이트 어댑터 모듈 안의 ~20줄이고, 이벤트 싱크와 같은 plugin-setup/AppHandle-capture 관용을 쓴다.

판단: FFI(ffi_channel.rs)·코어 표면(channels/dispatch/wire)은 무변경이므로 기준 (a)의 취지는 충족한다. 다만 엄격하게 "crates/rustra 무변경"으로 읽으면 tauri_support.rs 추가가 걸린다 — 경계 사실을 그대로 기록한다.

### (b) invoke 큐만으로 JS 콜백 라우팅이 되는가? — 불충족

JS 진입점 전송 수단은 **invoke**(요청↔응답 1:1 상관, 단 1회 resolve)와 **event.listen**(서버 푸시) 둘이다. 호스트 주도 push 는 listen 외에 셋째 경로 `WebviewWindow::eval`(호스트가 웹뷰에서 임의 JS 를 직접 실행 — tauri 2.11.1 `webview/webview_window.rs:2391`)이 더 있으나, 어느 쪽도 invoke 큐는 아니다. 채널 회신은 invoke 와 구조적으로 어긋난다:

1. **상관 없는 푸시다.** invoke 큐(packages/tauri → `createJsonEngine` 의 요청-응답 상관)는 각 호출이 정확히 한 번 자기 응답으로 resolve 되는 걸 전제한다. 채널 send 는 (i) 커맨드 실행 중 동기 일 수 있지만 (ii) 워커 스레드/이후 tick 에 비동기로 올 수 있고, (iii) in-flight invoke 이 하나도 없을 때도 도달해야 한다. channel_demo 는 전부 동기이라 우연히 envelope 에 실리는 척할 수 있지만, 그렇게 하면 채널의 존재 이유(호출 종료 후에도 사는 역방향 스트림 — channels.rs:8-11 "호출별 회신 채널")를 버리는 것이 된다. 더 강한 기계적 이유도 있다 — **프레임 귀속 수단이 코어에 없다.** `invoke_json(&self, name, params)`(package_json.rs:5)에는 invoke 문맥 매개변수가 없어, 동시 in-flight invoke 이 있으면 어떤 채널 프레임이 어느 응답 엔벨로프에 귀속되는지 판단할 수단이 코어에 없다. 스레드-로컬 invoke id 우회(`rustra_dispatch` 가 set/clear)로 같은-스레드 동기 send 만은 부분 귀속 가능하나(코어 무수정), 비동기·호출 생존 프레임은 커버하지 못해 전체 계약은 여전히 코어 invoke 경로의 문맥 전달(실질 코어 변경)을 요구한다 — 이 설계도 발급 커맨드(`rustra_channel_create`)는 어차피 필요해 (a) 비용을 줄이지 못한다.
2. **폴링으로 우회하면 (a)를 깬다.** Node 의 drain(0xfffe) 선례를 흉내 내려면 채널 send 를 어딘가에 쌓아뒀다가 `__drainChannel(handle)` invoke 로 털어야 하는데, `ChannelHost::send` 는 버퍼 없이 클로저를 즉시 실행한다(channels_host.rs:70-80). 버퍼 상태 + 예약 커맨드는 코어/어댑터 상태 신설이고 예약 cmd id 관행(loop_stdio.rs:18-23)까지 새로 만드는 셈이라, "invoke 큐로 해결"이 아니라 "invoke 위에 이벤트 전송 계층을 재발명"이 된다.
3. **실제 선례가 이 판정을 따른다.** 가장 유사한 호스트인 RN JSI 는 invoke/drain 큐로 채널을 흘리지 않았다 — 전용 C++ 콜백 디스패처(RustraJSIBridge.cpp:411-456)라는 아웃오브밴드 푸시 경로를 만들었다. Tauri 에서 그 아웃오브밴드 푸시 경로에 해당하는 것이 바로 event.listen 다. Node/Bun 이 채널 미지원인 것도 같은 이유다 — 루프 프로토콜에 푸시 프레임을 추가하지 않는 한 invoke/drain 큐로는 채널을 실을 수 없다.
4. **셋째 경로 eval 도 기각된다.** `WebviewWindow::eval` 로 `window.__rustraChannelRecv(handle, payloadJson)` 같은 전역 훅을 직접 실행하면 어댑터만으로 콜백 도달이 가능하고 listen 도 새 와이어도 불필요하다. 그러나 기각 근거가 명확하다: (i) eval 은 invoke 큐가 아니라 listen 과 같은 호스트 주도 push 다 — 기준 (b)를 문자 그대로 실패한다; (ii) 페이로드를 JS 소스 문자열에 결합하므로 이스케이프/인젝션 위험을 어댑터가 떠안는다; (iii) 순서·전달 특성은 listen 과 본질적으로 동일하다 — Tauri 의 listen 전달 자체가 webview.eval 로 구현된다(tauri 2.11.1 `src/webview/mod.rs:1975` 의 `emit_js` = `self.eval(emit_js_script(...))`, `src/event/mod.rs:194` 의 emit_js_script 는 `fn && fn(...)` 형태라 훅 부재 시 양쪽 다 조용히 유실 — 내비게이션 유실은 eval 고유 약점이 아니라 양쪽 공유 해저드다); (iv) 어떤 WebviewWindow 가 핸들을 만들었는지 추적 상태를 어댑터가 따로 두지 않으면 멀티윈도우 라우팅이 불가능하다 — Tauri 자체가 이 라우팅을 위해 웹뷰 라벨 키 리스너 레지스트리(`src/event/listener.rs:260-273` js_event_listeners)를 유지한다. raw eval 어댑터가 이 상태를 재발명해야 한다는 (iv)를 프레임워크 소스가 직접 증명한다. 가능은 하지만 (b) 실패는 그대로라 판정에 영향이 없다.

즉 (b)를 정직하게 답하면: invoke 큐만으로는 불가능하고, 채널 회신의 도달 경로는 listen(또는 eval) 같은 푸시 수단을 필요로 한다 — 가능하게 만드는 방법들은 전부 (b)를 벗어나거나 (a)를 위반하거나 채널 계약을 축소한다.

## 판정: 0.7 이월

- (a) 조건부 충족 — 코어/FFI 무변경, 단 tauri_support.rs 어댑터 커맨드 신설 필요
- (b) **불충족** — 채널 회신은 상관 없는 비동기 푸시이고, invoke 큐 외의 푸시 수단(listen, eval)은 어느 쪽도 "기존 invoke 큐"가 아니다

기준이 "둘 다 충족"이라 계획문 규칙에 따라 **0.7 이월**이 판정이다. 단, 이월이 "Tauri 에서 채널이 안 된다"는 뜻은 아니다 — `createChannel` 어댑터를 subscribeEvent 위에 얹으면(발급자 → `app.emit("rustra://channel/{handle}")`, JS 래퍼가 listen 을 콜백으로 변환) 실동선이 가능하다. 판정은 그 경로가 계획이 정한 "invoke 큐 전용" 기준을 벗어난다는 것이고, 채널의 유니캐스트 계약(channels.rs:17-21)과 Tauri emit 의 브로드캐스트 성격 사이의 계약 차이(핸들별 채널명으로 우회 근사할 뿐 강제되지 않음)까지 정리한 뒤 착지하는 편이 정직하다는 판단이다.

### 이월 사유 (근거 3)

1. **전송 수단의 구조적 어긋남** — `rustra_dispatch`(tauri_support.rs:39-48)는 단일 resolve 요청-응답이고, 채널 send(channels_host.rs:70-80)는 상관 없는 다중 푸시다. JS 진입점의 호스트 주도 푸시 수단은 listen 과 eval 이 있지만 둘 다 invoke 큐가 아니다.
2. **우회 설계가 (a)를 연쇄 위반** — invoke-envelope 동봉은 스레드-로컬 우회로 같은-스레드 동기 send 만 부분 귀속 가능할 뿐(`invoke_json` 에 문맥 매개변수가 없어 비동기·호출 생존 프레임은 귀속 불가 — 전체 계약 = 실질 코어 변경), drain 폴링은 버퍼 상태+예약 커맨드 신설로 코어 변경을 요구한다. 두 기준은 독립적으로 만족 불가능하다.
3. **선례 부합** — 채널을 실증한 유일한 실호스트(RN JSI)도 전용 푸시 경로(RustraJSIBridge.cpp:442)를 만들었지 invoke 큐를 쓰지 않았다. Tauri 의 동급 푸시 수단은 event.listen(또는 eval)이며, 그것을 쓰는 설계는 0.7 에서 계약 차이까지 정리하고 하는 편이 낫다.

### 0.7 착지 시 예상 작업 목록

1. `tauri_support.rs` — `rustra_channel_create`/`rustra_channel_drop` 커맨드(AppHandle 캡처, `event_channel` 관용 재사용하되 `rustra://channel/{handle}` 처럼 이벤트 이름공간과 분리되는 예약 세그먼트 설계).
2. `packages/tauri` — `createChannel(callback)` 어댑터(RN `react-native-events.ts:13-40` 계약과 동형: `{ handle, close() }`)를 subscribeEvent 위에 구현 + `tauri-events.ts` 끝의 코드젞 SubscribeFn 타입 정합 패턴 재적용.
3. 계약 문서 갱신 — channels.rs:17-21 의 "유니캐스트" 주장과 Tauri emit 브로드캐스트의 차이를 명시(핸들별 채널명 = 근사, 미강제). 대안으로 Tauri 2 네이티브 `ipc::Channel` 을 쓰는 설계도 있으나 그쪽은 커맨드 인자 deserialization 이 코드젠/스키마에 채널 인지를 요구하므로 코어 변경이 된다 — 0.7 설계 결정 포인트.
4. 검증 — `examples/tauri-calculator/src-tauri/tests/event_push.rs` 의 `MockRuntime` 헤드리스 패턴으로 channel send → listen 도달 E2E, `BenchmarkApp.tsx:1040-1060` 의 채널 E2E 대응.
5. 문서 — getting-started 채널 절에 Tauri 지원 수준(근사 유니캐스트) 명시 + changeset.
