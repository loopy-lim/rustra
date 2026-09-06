# 기능 × 어댑터 호환성 매트릭스

각 어댑터가 지원하는 invoke 기능(시그널/취소, 배치, 이벤트)의 행매트릭스.
어느 조합이 조용히 드롭되는지 — 그리고 드롭되지 않는지 — 한눈에 확인한다.

## 매트릭스

| 기능                                    | Node (`createNodeEngine`)                                                                                     | Bun (`createBunEngine`)                               | Tauri (`createTauriEngine`)                                                       | RN (`createReactNativeEngine`)          | RN (`createRkyvV2Engine`)                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `options.signal` (사전 abort)           | ✅ 즉시 `cancelled`                                                                                           | ✅ 즉시 `cancelled`                                   | ✅ 즉시 `cancelled`                                                               | ✅ 즉시 `cancelled`                     | ✅ 즉시 `cancelled`                                                                           |
| `options.signal` (진행 중 취소)         | ⚠️ 얕은 취소 (미abort signal 은 정상 실행, 실행 중 abort 는 결과 무시)                                        | ⚠️ 얕은 취소 (동일)                                   | ⚠️ 얕은 취소 (동일)                                                               | ⚠️ 얕은 취소 (JS 프라미스만 거부)       | ⚠️ 조건부 전파 — JS 코덱 + `invokeAsync`/`invokeCancel` 확인 시만 Rust 체크포인트까지         |
| `invokeBatch`                           | ✅ per-entry Promise fallback                                                                                 | ✅ per-entry Promise fallback                         | ✅ per-entry Promise fallback                                                     | ✅ per-entry Promise fallback           | ✅ 정적 명령 단일 횡단 (`invokeTypedBatch[ById]`), signal 항목 포함 시 항목별 라우팅          |
| 배치 항목별 취소                        | ✅ 각 `invoke`의 얕은 취소                                                                                    | ✅ 동일                                               | ✅ 동일                                                                           | ✅ 동일                                 | ⚠️ 단일 횡단 배치는 취소 미지원 — signal 항목이 있으면 자동으로 항목별 `invoke` 경로로 라우팅 |
| `options.timeoutMs`                     | ✅ 직접/글로벌 `invoke` 레이스 — `transport.timeout`(retryable)                                               | ✅ 동일                                               | ✅ 동일                                                                           | ⚠️ 동기 native 호출은 호출 중 선점 불가 | ✅ 동일 (글로벌 배치는 항목 최솟값으로 전체 레이스)                                           |
| 이벤트 (`subscribeEvent`/`onEvent`)     | ✅ `subscribeEvent(transport, name, cb)` — 0xfffd 푸시 프레임 (폴백 폴링; 이벤트 불능 transport 는 loud-fail) | ✅ `createBunEventBridge` — FFI 푸시 싱크 (폴백 폴링) | ✅ `subscribeEvent`/`subscribeTauriEvent` — decoded 우선 payload 계약 (아래 참조) | ❌ JSON adapter                         | ✅ `subscribeEvent`/`drainEvents` (CallInvoker 자동 drain)                                    |
| 채널 (`createChannel`)                  | ❌ transport 채널 소스 없음                                                                                   | ❌ transport 채널 소스 없음                           | ❌ Tauri 채널 어댑터 없음                                                         | ✅ JSI handle + `close()`               | ✅ JSI native channel handle                                                                  |
| rkyv V2 바이너리 (`createRkyvV2Engine`) | ✅ (napi/FFI 네이티브 필요)                                                                                   | ✅ (FFI 네이티브 필요)                                | ✅ (`rustra_dispatch` 바이너리 경로)                                              | —                                       | ✅ JSI                                                                                        |

## 시그널 시맨틱 상세

- **사전 abort**: 모든 어댑터가 즉시 `cancelled`로 거부한다 — 요청이 전송되기 전이다.
- **진행 중 취소**:
  - JSON transport(Node/Bun/Tauri 및 RN JSON adapter)는 왕복을 네이티브에 전달한 뒤
    실행 자체를 중단할 수 없다. **얕은 취소 정책**으로 JS Promise만 `cancelled`로
    거부하고 늦은 결과는 무시한다.
  - RN rkyv V2 엔진은 `invokeAsync`+`invokeCancel`이 있고 commandId/코덱 경로가
    확인되는 경우 Rust 체크포인트까지 **전파**한다. 정적 typed 경로, 구형 native,
    commandId를 확인할 수 없는 경로는 얕은 취소로 폴백한다.
- **타임아웃**(`options.timeoutMs`): 모든 엔진 공통 — 글로벌 `invoke`가 settle 레이스를
  건다. 만료 시 `transport.timeout`(retryable)으로 거부하며 지각 응답은 무시된다.
  배치(`invokeBatch`)는 항목별 `timeoutMs`의 **최솟값**으로 배치 전체에 레이스를 건다.
- **얕은 취소/타임아웃 ≠ 명령이 실행되지 않음**: 위 얕은 취소·타임아웃 ⚠️ 셀들은
  *JS 쪽 관측*을 표시할 뿐, Rust 실행을 표시하지 않는다. 얕은 취소 어댑터
  (`invokeCancel` 전파가 없는 `signal`)나 타임아웃 발화 뒤에도 Rust 명령은 계속
  실행되거나 이미 완료했다 — 버려지는 것은 결과이지 실행이 아니다. 따라서 `retryable: true`
  (`transport.timeout`, `cancelled`, `transport.error`)는 "재시도하면 해소될 수 있는
  실패 부류"일 뿐, "명령을 재실행해도 안전하다"를 뜻하지 않는다. 비멱등 명령은 상태
  재조회로 이전 시도가 자리 잡지 않았음이 확인된 뒤에만 재시도하라 —
  [rust-api-guide.ko.md](rust-api-guide.ko.md)의 "타임아웃·취소·재시도 의미" 절 참고.
- **이벤트 구독 호출형**: 생성된 이벤트 계약은 `(name, callback)`을 사용한다. RN은
  이 canonical 형식과 기존 `(native, name, callback)`을 모두 받고, Tauri는 선택적
  `listen` 주입 또는 global Tauri 이벤트 API를 사용한다.
- **이벤트 전달 경로**: Tauri는 Rust `app.emit` **푸시**, RN은 JSI 싱크 **푸시**,
  Bun은 FFI C 콜백 싱크 **푸시**(`rustra_ffi_event_sink_register` — 백그라운드
  스레드 emit 호스트는 `poll` 옵션 폴링 폴백), Node는 2-모드이다: `subscribeEvent`
  은 loop-stdio 런타임이 `events:"push"` 핸드셰이크를 수용한 경우 stdout 0xfffd
  프레임 **푸시**를 우선하고, 아니면(구 런타임, codecs 미제공 transport)
  `__drainEvents` 특수 명령 **폴링**(`RUSTRA_NODE_EVENT_POLL_MS`, 기본 100ms)으로
  폴백하며, 이벤트를 영원히 전달할 수 없는 transport 는 `event.unavailable` 로
  throw 한다. 폴링과 달리 푸시 모드(Node stdout, Bun FFI)는 첫 구독 전의 emit 을
  버린다(싱크가 버스를 우회) — 구독 전 emit 이 중요하면 구독을 먼저 하거나 폴링을
  쓴다. Rust `set_event_sink` 설치 시 버스가 비므로(푸시+폴링 이중 수신 방지
  계약) 푸시/폴링을 혼용하지 않는다.
- **Tauri payload 계약 (decoded 우선, 문자열만 1회 parse)**: 실제 WebView 경계에서
  tauri 는 `emit_str` JSON 을 `payload: {…}` 로 페이지에 인라인 splice 하므로 JS
  listener 는 이미 해석된 값을 받는다 — `subscribeEvent` 는 문자열이 아닌 payload 는
  그대로 전달한다(재파싱 없음, 객체 신원 보존). `typeof payload === 'string'` 일 때만
  정확히 한 번 `JSON.parse` 를 시도한다. 결과가 객체·배열·문자열이면 그 결과를
  전달하고(escape 된 JSON 문자열은 딱 한 번 풀림), 원시값(`'123'`, `'true'`)이면
  원본 문자열을 유지한다 — 문자열 payload 가 몰래 타입이 바뀌지 않는다. parse 실패 시
  원본 문자열을 전달한다. 내용 기반 추론은 없다: JSON 처럼 생긴 문자열도 문자열로
  남는다. 레거시 주입 transport(직렬화된 문자열을 주는 `__TAURI__` fake)도 같은
  규칙으로 커버되며 별도 모드는 없다. 두 전달 모드 간 알려진 갈림 하나: 원시 타입
  이벤트 payload 는 실제 WebView 에선 원시값 그대로(`payload: 42`), 레거시 문자열
  transport 에선 원본 문자열(`'42'`)로 온다 — 프로덕션 경계는 실제 WebView 다.

## invokeBatch 시맨틱

- 모든 어댑터가 Promise 기반 `invokeBatch`를 노출한다. Node/Bun/Tauri/RN JSON은
  각 항목을 공통 `invoke`로 실행하고 순서를 보존한다. rkyv V2 엔진은 지원되는
  정적 명령만 단일 native crossing으로 묶는다.
- 정적 명령 + signal 없음 → 단일 JSI 횡단(`invokeTypedBatchById` 우선).
- 동적 명령 혼합 또는 signal 포함 → 항목별 `invoke`로 라우팅(각 항목의 취소 정책 적용).

## 참고

- **검증된 조합**: npm `@rustra/*` 0.6.x ↔ Rust crate 0.5.x (워크스페이스)가 현재 CI가 검증하는 조합이다. crates.io 버전 bump는 어댑터 코드가 아니라 발행 절차의 단계다 — 문서화된 쌍은 발행 단계에서만 움직인다.
- **엔진 슬롯은 단일 엔진** (bootstrap 소유권): 첫 `configureLazy`/`configure` 등록이 승리하고, 첫 등록이 아직 소비되지 않은 상태에서의 두 번째 bootstrap 등록은 import 순서로 조용히 이기는 대신 `registry.frozen` 을 throw 한다. dispose/reload 재등록과 소비 뒤 교체는 기존대로 허용. 다중 엔진은 미지원.
- **런타임 증거가 닿지 않는 플랫폼**: 이 매트릭스와 README 플랫폼 매트릭스의
  런타임 주장은 거기에 적힌 특정 host/OS/빌드 조합 — macOS(Tauri WebView,
  Node, Bun), iOS 시뮬레이터(RN), Android 에뮬레이터와 `TB710FU` arm64 실기기(RN),
  wasm 스파이크의 에뮬레이터/시뮬레이터 — 가 뒤받는다. 그 조합 밖의 전부(예:
  Windows 의 Tauri, Tauri Linux WebView 사용자 흐름, 다른 Android/iOS 기기,
  RN Windows/macOS 호스트)는 여기 어떤 런타임 주장에도 닿지 않으며 이 매트릭스는
  그에 대해 아무것도 주장하지 않는다. 실행별 수동 검증:
  [검증 체크리스트](verification-checklist.ko.md).
- 어댑터별 안정 범위와 게이트: [compatibility-contract.md](compatibility-contract.md)
- 취소 전파 설계: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`

### 기계 판독 표면: `engine.supports` (A02)

각 어댑터의 엔진 팩토리는 `supports` 객체(`@rustra/types` 의 `EngineSupports`)를
노출한다. 값은 이 매트릭스의 셀을 1:1 로 옮긴 것 — 새 주장이 아니다. 앱은
부작용 이전에 분기할 수 있다(예:
`engine.supports?.cancellation === 'cooperative'`). 열별 매핑:

| `supports` 필드     | Node        | Bun JSON / Bun FFI rkyv V2 | Tauri       | RN JSON     | RN rkyv V2        |
| ------------------- | ----------- | -------------------------- | ----------- | ----------- | ----------------- |
| `cancellation`      | `shallow`   | `shallow` / `shallow`      | `shallow`   | `shallow`   | `cooperative`     |
| `batch`             | `per-entry` | `per-entry` / `per-entry`  | `per-entry` | `per-entry` | `single-crossing` |
| `events`            | `push`      | `push` / `push`            | `push`      | `none`      | `push`            |
| `channels`          | `false`     | `false` / `false`          | `false`     | `true`      | `true`            |
| `timeoutPreemption` | `true`      | `true` / `true`            | `true`      | `false`     | `true`            |

엔벌레 하나에 담지 않는 뉘앙스는 열거값이 아니라 매트릭스 산문에 남아 있다:
RN rkyv V2 의 `cancellation: 'cooperative'` 는 매트릭스의 "조건부 전파" 셀을
뜻한다(`invokeAsync`+`invokeCancel` 이 노출되고 commandId/코덱 경로가 확인될
때만 Rust 체크포인트에 닿고, 정적 typed 경로와 구형 네이티브는 얕은 취소로
폴백). Bun FFI rkyv V2 엔진은 같은 `createRkyvV2Engine` 코어를 공유하지만 FFI
네이티브는 `invokeRkyvV2`/`getSchema`/`getContractHash`/`getSchemaGeneration`
만 바인딩한다 — `invokeAsync`/`invokeCancel`·`invokeTypedBatch` 심볼은
바인딩되지 않아 조건부 전파와 단일 횡단 조건이 도달 불가이며, 엔진은
`shallow`/`per-entry` 로 관측된다. RN async 엔진(`createAsyncEngine`)은
`invokeBatch` 를 async `invoke` 위의 항목별 `Promise.all` 로 실행하므로 sync
엔진의 `cancellation: 'cooperative'`(`invokeCancel` 노출 시 참)를 상속해도
`batch: 'per-entry'` 를 보고한다. 이벤트 `'push'` 값은 각 엔진의 폴링 폴백을
포함한다 — 실제 전달 경로는 어댑터별 구독 표면이 판별한다. Tauri 의
`batch: 'per-entry'` 는 트랙 E2 가 단일 IPC 와이어 배치(`rustra_dispatch_batch`)
최적화를 추가했어도 셀 계열을 따른다.

### bootstrap 수명 상태 (A05)

bootstrap 객체(`createNodeBootstrap`/`createBunBootstrap`/
`createTauriBootstrap`/`createRustraBootstrap`)는 로컬 상태
`state: 'initializing' | 'ready' | 'disposed'` 를 노출한다. `dispose()` 는
멱등(두 번째 호출은 no-op)이고, dispose 뒤의 `ready()` 는 조용히 재해상하는
대신 loud-fail 한다. `NodeBootstrap.reload()` 는 bootstrap 이 소유한
transport 가 `drain(timeoutMs)` 을 노출할 때 그 transport 를 drain 한다
(duck-typing; 기본 5초 가드 — 타임아웃 후에도 reload 는 진행)하고, 없으면 즉시
진행한다(원샷 stdio transport 에는 drain 이 없다; 루프 transport 호스트는
NodeBootstrap 을 통해 연결되지 않는다). `draining` 상태는 의도적으로
모델링하지 않는다 — drain 은 3상태 수명 주기에 투명하다.

## 스파이크: wasm3 안의 wasm32 엔진 (React Native) — 판정: PASS (스파이크)

Task A0 스파이크(`examples/rn-wasm-spike/`, 2026-08-31)는 `wasm32-unknown-unknown`으로
컴파일한 rustra 엔진이 React Native 앱에 내장된 wasm3 인터프리터 안에서 구동됨을
증명했다. JSON 어댑터와 rkyv V2 JSI에 이은 세 번째 실행 모드:

| 항목                | 결과                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 플랫폼 증명         | ✅ iOS 시뮬레이터(iPhone 17) AND Android 에뮬레이터(API 36 arm64) — 실제 `.wasm`, 실제 wasm3 v0.9.1, 실제 RN 0.81.5 앱                                                                                                                                          |
| wasm vs 네이티브    | ✅ postcard 응답이 두 커맨드·두 플랫폼 모두 네이티브 staticlib 엔진과 바이트 동일 (`double(21)` → `01010c7b2276616c7565223a34327d00`)                                                                                                                           |
| 인앱 엔진 스왑      | ✅ `engine_v1.wasm` → `engine_v2.wasm` 프로세스 재시작 없이 재인스턴스화(iOS는 Documents 푸시, Android는 `adb push` + filesDir — OTA 드롭 방식): engineVersion 2→3, **계약 해시 불변**(`e79b7f01…`), in-wasm `double(21)` 42→63 (네이티브 베이스라인은 42 유지) |
| 스왑 후 계약 안정성 | ✅ 네이티브/wasm·엔진 v1/v2 전부 해시 동일 — frozen-contract 불변식이 디바이스에서도 성립                                                                                                                                                                       |
| 성능 레드플래그     | ✅ 없음 — instantiate 1–4 ms; 호출당 wasm 0.1–20 ms vs 네이티브 0.03–0.05 ms (게이트: 호출당 네이티브 100배 초과, instantiate 10초 초과)                                                                                                                        |
| 코어 패치 필요 여부 | ✅ 없음 — sync FFI 엔트리만 사용; wasm 경로에서 async 워커 풀은 초기화되지 않음 (`examples/rn-wasm-spike/NOTES.md` 참조)                                                                                                                                        |

범위 주의: sync 커맨드만 (atomics 없는 wasm32에서 async 워커 풀은 패닉),
스테이징 프로토콜은 스파이크 전용 `spike_alloc`/`spike_unstage` 익스포트 사용,
증거는 에뮬레이터/시뮬레이터 캡처 — 실물 디바이스는 미검증. 전체 hex
트랜스크립트: `examples/rn-wasm-spike/evidence/{ios,android}.md`.

## 핫스왑 후속 (Task A1): 프로세스 내 리셋 채택 — dlopen 스왑 미채택

Task A1(dev 루프 reload 오케스트레이션, 2026-08-31)은 A0 판정에 따라
**프로세스 내 엔진 리셋**을 1차 메커니즘으로 채택했다. 진짜 dlopen 스왑은
검토 후 기각했다:

- **Node**: 엔진은 자식 프로세스라 reload = 자식 dispose → 재스폰(새 바이너리
  이미지는 스폰 시점에 읽힌다). 두 가지 경로: 루프 호스트는
  `NodeLoopTransport.drain(timeoutMs = 5s)` 로 진행 중 invocation 을 우아하게
  정착시킨 뒤 drain → dispose → 재부트스트랩을 거치고, 원샷 프로세스
  트랜스포트의 `NodeBootstrap.reload()` 는 drain 이 없어 얕은 취소(dispose 시
  진행 중 invocation reject) 후 재부트스트랩 + ready 로 간다. cargo 재빌드
  산출물은 reload 만으로 반영된다.
- **Bun**: 실측 결과(macOS arm64, Bun 1.4.0; 버전 함수를 가진 미니 dylib 양방향
  검증 + 실제 calculator cdylib close/재 dlopen 확인): `bun:ffi` dlopen 은
  프로세스당 라이브러리 이미지를 캐시한다. 같은 경로의 파일이 교체되어도 닫지
  않은 핸들을 하나라도 연 적 있으면 예전 바이트를 돌려주고, close-후-재 dlopen
  만 새 바이트를 얻는다. 실제 엔진은 모든 핸들 종료를 보장할 수 없으므로(codecs
  맵·생성 클로저가 핸들을 붙잡을 수 있음) `BunBootstrap.reload()` 는 엔진 상태를
  재초기화하고 재빌드된 cdylib 은 다음 프로세스 시작 시 적용된다고 loud warning
  을 낸다. 계획의 "새 바이너리는 다음 프로세스 시작 시 적용" 옵션의 정직한
  구현이다.
- **Tauri**: 문서만. 어댑터는 Tauri IPC(`rustra_dispatch`) 위의 상태 없는
  래퍼라 재초기화할 엔진 상태가 없고, 바이너리 교체는 Tauri 호스트 프로세스의
  책임이다(앱 재시작, 또는 이번 사이클에 착수한 A2 `rustra_ffi_hot_reload` 주입).
- **Dev 루프**: `rustra dev` 는 watch 핸들에 `onReload` 훅을 노출하고, Rust 측이
  바뀐 재생성 성공 후 방출한다(레거시 레이아웃: `plan.rustBin` 실행 시; config
  모드는 원인 구분이 불가해 성공한 재생성마다 방출 — 보수적 기본값). 훅 에러는
  기록되고(`[dev] reload failed: …`) watch 루프를 죽이지 않는다. 진행 중
  invocation drain 은 호스트 콜백의 책임이다.

## wasm dev 타깃 (Task A3): 빌드 오케스트레이션 + doctor 고지 + 릴리스 가드

`dev.target = "wasm"` 이면 `rustra dev`(config 모드)가 코드젠마다 엔진의 wasm32
빌드를 오케스트레이션한다. A0 스파이크의 실제 명령과 산출물 레이아웃을 그대로
쓴다(`cargo build --manifest-path <Cargo.toml> --target
wasm32-unknown-unknown --release` →
`<target>/wasm32-unknown-unknown/release/<lib 타깃 이름>.wasm` — cargo 는 cdylib
산출물 이름을 패키지 이름이 아니라 **lib 타깃** 이름(`-`→`_`)에서 가져온다. RN의
`lib${rustLibrary}.a` 관례와 같은 `[lib] name` 근원이다; cdylib 타깃, 릴리스
프로필은 A0 검증 구성 — opt-level "s", panic=abort). 엔진 crate 해석은 RN
어댑터와 동일한 우선순위(`reactNative.rustManifest`/`rustPackage` →
`codegen.*`)를 따르되, 코드젠 매니페스트 폴백이 어댑터의 상위 탐색 단계를
대신한다 — 이미 존재가 보장된 값이라 해석 실패는 cargo metadata 단계에서
loud 하게 실패한다. 빌드된 아티팩트 경로를 안내한다
(`[dev:wasm] engine artifact: <path>`). 그 파일을 기기로 푸시하는 것은 호스트
통합점이다(adb push / Documents 드롭 — A0 앱의 흐름) — CLI 가 자동화하지
않기로 명시적으로 결정했다. wasm 빌드 실패는 parity 게이트와 reload 방출보다
**먼저** 전파된다 — 존재하지 않는 엔진에 대한 reload 신호는 호스트에 가지 않는다.
A2 parity 게이트는 그대로 결합된다.

doctor 검사 2건이 타깃을 따라온다: wasm dev 타깃이 실험 상태라는 경고(required
아님) — **협동형 취소만 유효 — 릴리스 전 native 검증 필수**(동시성 버그 —
race/취소/백프레셔 — 는 단일스레드 협동형 wasm32 에서 재현되지 않음), 그리고
`wasm32-unknown-unknown` rustup 타깃 설치 여부의 필수 검사. 릴리스 정합성
스크립트는 이제 어떤 발행 패키지의 `files` 가 wasm 백엔드를 싣는다면(`wasm3`
소스, `wasm32*` 산출물, `wasm-backend` 디렉터리, `*.wasm` 엔진) fail 한다 —
백엔드는 버전 정책으로 승격되기 전까지 dev 전용이다.
