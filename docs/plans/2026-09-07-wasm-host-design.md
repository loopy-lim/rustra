# WASM 호스트 — 설계 (2026-09-07)

상태: 설계 제안(구현 계획 아님 — 슬라이스 순서는 방향 제시만).
근거 리서치: `docs/research/2026-09-07-wasm-host.md` (이하 "리서치" — file:line 근거는
전부 거기에 있다).
격차 정의: `docs/research/2026-09-07-competitive-landscape.md:40` — "웹/WASM 호스트
부재 — 가장 큰 시장 공백". `docs/plans/2026-09-07-platform-interop-followup.md:24`가
"WASM 호스트(격차 #1, 별도 설계 필요)"로 지정한 트랙의 설계 문서다.

## 0. 설계 전제 (리서치 결론 요약)

1. 코어는 이미 wasm32-unknown-unknown으로 컴파일된다(CI `rust-wasm32` check +
   로컬 재현, 리서치 §1.1) — cfg 게이트는 현재 0개(§1.2).
2. 런타임 위험은 3종으로 수렴한다(§2): async 풀 `std::thread::spawn` 트랩(지연
   초기화라 미도달 가능) / `block_on`의 `thread::park`가 no-op로 즉시 반환해
   Pending future는 무한 busy-spin(본 리서치 실험 신규 확인) / 함수 포인터 인자
   (이벤트·채널·async 완료 콜백)는 호스트 import가 필요.
3. 32개 `rustra_ffi_*` 심볼이 수정 없이 wasm exports로 노출된다(실험 2) — 바이너리
   와이어(rkyv V2/postcard) 경계는 유효하며 JS 생성 코덱을 그대로 재사용한다(§7.2).
4. 실측: 2-커맨드 엔진 raw 881 KiB / gzip 217 KiB(§6.4). 동기 왕복 1.56 µs —
   Node napi rkyv V2 기준선(2.91 µs)보다 빠른 수준.

## 1. 대상 스코프

### 1.1 1차 목표 환경

**"표준 `WebAssembly` JS API를 갖는 범용 JS 환경"** — 동일 glue로 다음 전부를
커버하는 단일 패키지(`@rustra/wasm`)를 목표로 한다:

| 환경                                | 위치                           | 비고                                                                                                                                                      |
| ----------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 모던 브라우저(메인 스레드)          | 1차                            | 런타임 증거의 주 타깃(headless Chromium CI)                                                                                                               |
| 브라우저 Web Worker                 | 1차(동일 바이너리)             | 동기 export는 Worker 안에서도 그대로 동작 — 별도 바이너리/COOP·COEP 불요. "무거운 엔진은 Worker에" 권장 가이드만 제공                                     |
| Node/Bun/Deno(`WebAssembly` global) | 1차 지원 표면, 증거는 Node부터 | 패키지는 순수 ESM JS + `WebAssembly` 표준 API만 사용 — 플랫폼 API(브라우저 fetch 전용 등)에 하드 의존 금지. Node 런타임 스모크를 CI 증거의 두 번째 축으로 |

근거: 표준 API만 쓰면 4환경이 무상 호환된다(스파이크가 이미 Node 계열이 아닌
wasm3에서도 표준 프로토콜이 성립함을 증명 — 경계 계약이 호스트 무관이기 때문,
리서치 §1.3). 트랜스포트 탐지/캐시 등 로딩 세부는 §6에서 계약화한다.

### 1.2 non-goals (명시적 제외)

1. **WASI(wasm32-wasip1)** — napi-rs의 "WASM(WASI)" 경로(competitive-landscape.md:34)와
   달리 rustra는 파일/프로세스 표면이 없어 WASI 부가가치가 없고, 별도 타깃
   유지비만 생긴다. 필요성 제기 시 별도 트랙.
2. **SharedArrayBuffer 멀티스레드(atomics 빌드)** — COOP/COEP 배포 헤더 요구로
   채택 장벽(리서치 §6.2, 미확인 외부 사실). 2.3의 확장 경로로만 남긴다.
3. **채널(1차)** — 채널 전달은 콜백 import 기반(리서치 §5.2). 후속 슬라이스.
4. **wasm3/RN dev 백엔드의 프로덕션 승격** — 기존 dev-only 규정(compatibility-
   matrix.md:209-213 release guard) 유지. 본 설계의 JS 호스트와 무관.
5. **async FFI 엔트리 지원** — §3.3의 즉시 실패 프레임 계약으로 대체.
6. **Electron 어댑터** — roadmap-design.md의 별도 항목.

## 2. 실행 모델 — 권고: ① 단일 스레드 즉시 실행(동기 export)

### 2.1 선택

**옵션 ①(단일 스레드, 동기 export 직접 호출)** 을 권고한다. 리서치 §6.1 비교의
요지:

- **계약 정합**: sync FFI 엔트리의 계약(요청 바이트 → 응답 바이트, 정확히 1회
  해제)이 그대로 유효하다. ②(명시적 펌프)는 "진행 중" 상태 머신을 신설해야 하며
  이는 4호스트 어느 계약과도 다른 5번째 의미론이다 — EngineClient의 Promise
  표면과 조합하면 이중 비동기가 된다.
- **증거**: 스파이크가 기기(iOS/Android)에서 이 모델의 전 프로토콜을 증명했다
  (리서치 §1.3). ②는 미증명 신규 설계, ③은 원자성 재빌드 + 배포 헤더 요구.
- **성능**: 실측 1.56 µs/호(리서치 §6.4)로 napi 기준선 이하 — 경계 비용이
  펌프/워커 도입을 정당화하지 않는다.
- **복잡도**: JS glue는 스파이크 스테이징 프로토콜의 이식(~100줄 수준, §5)으로
  국한된다.

### 2.2 ①의 비용을 정직하게 노출

- 긴 핸들러는 호출 스레드를 블록한다 → `timeoutPreemption: false`(RN JSON 선례,
  react-native-core.ts:53-59와 동일 셀). 무거운 엔진은 Worker 권장(§1.1).
- in-flight 취소 개념이 없다(동기 호출은 반환 전에는 in-flight이 아니다) →
  `cancellation: 'pre-abort'`(dispatch 전 abort만 관측).

### 2.3 Worker/SAB는 배타적이지 않은 확장 경로

①은 Worker 안에서 그대로 동작한다(동일 .wasm, 동일 glue). "메인 스레드 블록
회피"가 필요한 앱은 Worker 인스턴스화가 1차부터 가능하다. SharedArrayBuffer 기반
진짜 백그라운드 실행(③)은 별도 트랙으로 남긴다 — COOP/COEP 요구와 원자성 빌드가
프레임워크 차원의 채택 조건이 되기 때문(non-goal #2).

## 3. 코어(Rust) 설계 — 최소 3가지 변경

원칙: **기존 심볼의 시맨틱은 건드리지 않고, wasm 전용 추가물은
`#[cfg(target_family = "wasm")]`으로 게이트한다.** 이는 스파이크 NOTES의
production 권고 #1·#3(리서치 §2.1, §4.2)을 구현화한 것이다.

### 3.1 스테이징 ABI 코어 승격 — `rustra_wasm_alloc` / `rustra_wasm_unstage`

- 신규 wasm 전용 export 2개(스파이크 `spike_alloc`/`spike_unstage`의 일반화 —
  NOTES production 항목 3):
  - `rustra_wasm_alloc(len: usize) -> usize` — 정렬 16 `std::alloc` 스테이징
    영역 오프셋 반환. 해제 책임은 호스트의 `rustra_wasm_unstage(offset, len)`
    호출(동일 len) — 누락 시 의도적 누수(스파이크와 동일 계약, 리서치 §2.3).
  - `rustra_wasm_unstage(offset: usize, len: usize)`.
- **invoke 진입은 기존 심볼을 그대로 재사용한다**: `rustra_ffi_invoke_rkyv_v2`의
  시그니처 `(payload: *const u8, payload_len: usize, out_len: *mut usize) -> *mut u8`은
  wasm에서 `(i32, i32, i32) -> i32`로 컴파일되고, 포인터 인자는 곧 선형 메모리
  오프셋이다(wasm32는 포인터/usize 4바이트 — 스파이크가 4바이트 out-len 슬롯으로
  실증). 따라서 `spike_invoke` 같은 wasm 래퍼는 불필요하고, 스파이크 프로토콜의
  1·2·3·5·6단계(alloc→기록→out-len 슬롯→뷰 재동기화→free/unstage)만 JS glue
  책임이 된다(§5).
- 해제는 기존 `rustra_ffi_free`(헤더 복원, ffi_lifecycle_entries.rs:111)·
  `rustra_ffi_free_owned_bytes`를 그대로 쓴다 — 8바이트 헤더("RUST" 매직+u32 LE
  길이, ffi_prelude.rs:97-115)와 debug free_guard(ffi_free_guard.rs) 검증은
  오프셋 주소에서도 동일 작동(usize 키).
- 스키마/해시 표면도 재사용: `rustra_ffi_get_schema`·`rustra_ffi_contract_hash`·
  `rustra_ffi_schema_generation`(RkyvV2SchemaNative 옵션 멤버와 1:1, 리서치 §7.1).

### 3.2 async 엔트리 — 즉시 실패 프레임 전달(스폰 경로 원천 봉쇄)

- 게이트 대상: `rustra_ffi_invoke_async`, `rustra_ffi_invoke_json_async`,
  `rustra_ffi_invoke_rkyv_v2_async`, `rustra_ffi_invoke_rkyv_v2_async_into`
  (및 이들이 닿는 `ffi_pool.rs`/`ffi_workers.rs` 본문 — 게이트된 엔트리에서만
  참조되므로 wasm 바이너리에서 제거된다).
- 동작: wasm에서는 풀 제출 대신 **완료 콜백을 동기적으로 정확히 1회** 호출하되
  페이로드는 `invoke.unsupported_on_wasm` 에러 프레임이다. 구현은 기존
  `deliver_spawn_failure`(ffi_lifecycle_entries.rs:6-26 — "spawn 실패 시 완료를
  에러 프레임으로 전달"하는 정확히 이 계약의 헬퍼)을 재사용한다. 콜백 계약
  (정확히 1회, 버퍼는 rustra_ffi_free)이 보존되므로 호스트는 별도 분기 없이
  기존 디코딩으로 처리한다.
- 에러 코드: `RustraErrorCode`에 `InvokeUnsupportedOnWasm: 'invoke.unsupported_on_wasm'`
  추가(패키지 슬라이스에서 — NOTES 권고 문구 존중, 리서치 §7.4).
- 취소 표면: `rustra_ffi_invoke_cancel`/`_cancellation_status`는 동작 불변
  (레지스트리만 조작, 스레드 무관 — cancel.rs는 AtomicU64+Mutex BTreeMap,
  리서치 §2.1)이지만 발급될 일이 없어 사멸한다. 시맨틱은 §2.2의 'pre-abort'로
  문서화.

### 3.3 이벤트 drain export 신설 — `rustra_wasm_take_pending_events`

- `rustra_wasm_take_pending_events(out_len: *mut usize) -> *mut u8`
  (cfg wasm) — 기존 `EventBus::take_pending_events_with_stats`
  (events_bus.rs:60, 드랍-올데스트 capacity 1024 + 드랍 카운터 포함)을
  `alloc_response` 프레임(JSON)으로 반환. 페이로드 셰이프는 기존 drain 소비자와
  동일한 `{name, payload}[]` JSON 배열(node-loop.ts:671-678, loop_stdio.rs:59 —
  "NDJSON drain 페이로드와 동일 셰이프")로 통일한다. JSON 파싱은 JS 어댑터에서
  1회 — 이벤트 싱크의 기존 철학(ffi_event_entries.rs:6-7).
- 필요성 근거: `take_pending_events`는 현재 Rust API일 뿐이고 `__drainEvents`는
  엔진 바이너리(loop_stdio.rs)가 자체 구현한다 — wasm엔 그 층이 없다(리서치 §2.5).
- 푸시(`rustra_ffi_event_sink_register`)·채널(ffi_channel.rs) 진입은 그대로
  export되지만 1차 glue는 호출하지 않는다 — 함수 포인터 인자는 JS가 import
  없이는 공급할 수 없어(리서치 §2.3) 미사용 심볼로 남는다. 콜백 import 재설계는
  후속 트랙.

### 3.4 `block_on` busy-spin 위험 — 계약으로 다룬다

async fn 커맨드를 sync 엔트리로 호출하면 매크로 생성 래퍼
(macro_command.rs:255)가 `block_on`에 들어가고, Pending이면 park no-op 폴링
무한루프가 된다(리서치 §2.2 실험). 첫 poll에 완결하는 future는 정상 동작한다.
코드로 원천 차단할 수 없는 런타임 성질이므로:

- **지원 계약 명문화**: "wasm 호스트에서 async fn 커맨드는 첫 poll에서 완결해야
  한다(외부 대기 타이머·IO에 걸리면 안 됨). 보장할 수 없으면 sync fn으로
  작성하라." rust-api-guide(.ko)에 추가.
- doctor: 기존 wasm dev 타깃 경고(doctor-checks.ts:349-360, "cooperative
  cancellation only")에 async-fn 주의문을 붙인다.
- wasm-aware 실행기(폴링 예산 초과 시 에러 반환)는 매크로 래퍼 시그니처 변경을
  수반해 열린 질문으로 남긴다(§10).

### 3.5 게이트·미러링 검증 전략

- `rust-wasm32` CI 잡은 `cargo check`에서 **`cargo build --release`(산출 존재
  단언) + 크기 receipt**로 강화한다(§7). check가 cfg 게이트 빌드를 커버하므로
  게이트 누락 파손은 여기서 잡힌다.
- 반대 방향(네이티브 빌드가 wasm 게이트 코드를 검증 못 함)은 클래퍼 사각이
  된다 — 게이트 내부 로직은 최소(alloc/unstage/drain 래핑)로 유지하고, 본문이
  필요하면 `#[cfg]` 양쪽에서 컴파일되는 공용 함수로 뽑아 네이티브 단위테스트로
  검증한다.
- 게이트 판정식은 `target_family = "wasm"`(NOTES 권고 문구) — wasm32-unknown-unknown
  기준으로 실증됐고 wasip1에도 참이 되어 무해하다.

## 4. 바인딩 전략 — raw wasm exports(손수 glue), wasm-bindgen 도입 안 함

### 4.1 결정

**wasm-bindgen/wasm-pack 도입하지 않는다.** JS glue는 `@rustra/wasm` 패키지가
스파이크 프로토콜 기반으로 손수 구현한다. 근거(리서치 §4 전체):

1. **경계가 JsValue가 아니라 바이너리다** — 4호스트 공통 와이어(rkyv V2/postcard)
   를 유지하는 것이 프로젝트의 핵심 자산(competitive-landscape.md:23조차
   "JSON 왕복은 ~10배 느림"으로 JsValue 직접 전달의 함정을 지적). JsValue
   마샬링 중심 도구의 이점이 이 계약과 직교한다.
2. **코어 무결점 승격**: 코어 크레이트는 4호스트가 공유하는 단일 크레이트다.
   wasm-bindgen 의존을 붙이면 네이티브 호스트 전부가 그 비용(컴파일·심볼·
   audit 표면)을 공유한다 — "최소 의존/명시적 계약" 성향 위반. 반대로 raw
   exports는 코어 수정 0베이스에서 시작함을 실험으로 확인했다(리서치 §2.3).
3. **해제 경계 단일화**: 기존 `rustra_ffi_free`/free_guard 헤더 계약(리서치 §4.3)이
   그대로 wasm의 메모리 계약이 된다. wasm-bindgen의 자동 메모리 관리는 이
   계약과 이중화된다.
4. **선례 일관성**: Bun 어댑터가 이미 손수 정의한 FFI 테이블(bun-ffi.ts:51-66)과
   adding-host 가이드의 "C FFI → 플랫폼 FFI 메커니즘으로 래핑" 의사결정나무
   (extending/adding-host.md:281-308)가 같은 패턴이다. wasm의 "플랫폼 FFI
   메커니즘"이 WebAssembly exports+선형 메모리일 뿐이다.
5. **wasm-pack 불요**: 빌드 오케스트레이션은 이미 `dev.target="wasm"`(A3,
   compatibility-matrix.md:184-203)이 cargo 명령으로 수행한다. npm 발행물은
   JS 전용(§8)이라 번들러 통합 도구가 필요 없다.

트레이드오프 수용: 손수 glue의 유지비(뷰 재동기화·해제 등 계약 테스트)와
web-sys 상호운용 표면 부재(향후 브라우저 API 연동이 필요해지면 import 객체
확장으로 설계 여지를 남긴다 — §10).

### 4.2 wire 포맷 — rkyv V2 재사용, 경계는 "선형 메모리 스테이징"

- **rkyv V2 직렬은 wasm에서 그대로 유효하다.** 인코딩/디코딩은 이미 JS 생성
  코덱(`RkyvV2Codec.encode/decode`, public.ts:131-147)이 수행하고 wasm은
  **순수 바이트를 왕복할 뿐**이므로, 코덱 3벌 문제(roadmap-design.md:138 경고)는
  구조적으로 재발하지 않는다(리서치 §7.2). postcard 경로의 바이트 동일성은
  스파이크가 기기에서 증명(리서치 §1.3).
- 경계 계약(호출 1회, JS glue 내부):
  1. `off = rustra_wasm_alloc(reqLen)` → `new Uint8Array(memory.buffer)`에 기록.
  2. `lenOff = rustra_wasm_alloc(4)` → 0으로 초기화.
  3. `respOff = rustra_ffi_invoke_rkyv_v2(off, reqLen, lenOff)` — 응답은
     `rustra_ffi_free` 계약 버퍼(8바이트 헤더 포함 할당, user_ptr 반환).
  4. **memory.buffer 뷰 재취득**(grow 가능성 — 스파이크 5단계, wasm3-smoke-main.c),
     `respLen = DataView.getUint32(lenOff, true)` 판독, JS로 복사.
  5. `rustra_ffi_free(respOff, respLen)`; `rustra_wasm_unstage(off, reqLen)`;
     `rustra_wasm_unstage(lenOff, 4)`.
  - 재사용 버퍼 최적화: 요청 스테이징 영역을 glue가 캐시해 매 호출 alloc/unstage를
    건너뛴다(부족 시 재할당 — `encodeInto` 재사용 버퍼 철학, public.ts:135-141과
    동형). 응답은 JS 소유 ArrayBuffer로 복사되므로 `RkyvV2SchemaNative`의
    "뷰는 디코드 동안에만 유효" 계약(live-schema.ts:23-27)과 정합.
- probe→write(`*_into`) 2단계 경로는 1차에서 **쓰지 않는다**: 선형 메모리 경계에선
  호스트 버퍼가 곧 wasm 메모리 안이라 별도 caller-buffer 이점이 줄고, 스파이크
  증명 프로토콜이 단순 1단계다. Bun의 재시도 프로토콜(bun-ffi.ts:104-142)은
  참고 선례로만 남긴다.

## 5. `@rustra/wasm` 패키지 — 엔진 조합

### 5.1 구조

- 신규 패키지 `packages/wasm`(`@rustra/wasm`), 의존 `@rustra/types`만.
  배포물은 **순수 ESM JS + d.ts**(브라우저/Node/Bun/Deno 공용). `.wasm`은
  사용자 엔진 빌드 산물 — 패키지에 싣지 않는다(§8 release guard 정합).
- 공개 표면:
  - `WASM_ENGINE_SUPPORTS: EngineSupports`(§7 상수) + `createWasmBootstrap(...)`
    → `{ state, ready(): Promise<RkyvV2Engine>, dispose() }`(§6).
  - `subscribeEvent(name, cb, { pollMs })` — §5.3.
  - 로딩 유틸(옵션): `wasmUrl`/`wasmBytes`(ArrayBuffer)/`compileModule`
    (WebAssembly.Module) 중 하나. URL 지정 시 `instantiateStreaming` 우선 +
    MIME 폴백(배포 서버가 application/wasm을 못 줄 때) — 폴백 실패는 loud.

### 5.2 엔진 생성 — `createRkyvV2Engine` 재사용

glue의 네이티브 어댑터는 `RkyvV2SchemaNative`(live-schema.ts:20-41)만 구현한다:

```
invokeRkyvV2(payload) → §4.2 5단계 프로토콜
getSchema()           → rustra_ffi_get_schema 스테이징
getSchemaGeneration() → rustra_ffi_schema_generation (스칼라 반환, 스테이징 불요)
getContractHash()     → rustra_ffi_contract_hash 스테이징
```

이 인스턴스를 `createRkyvV2Engine(native, rkyvV2Codecs, options)`
(rkyv-engine.ts:20-35)에 넘기면 **라우팅(정적 postcard fast path/동적 Tier 3
폴백)·invokeById·invokeBatch(per-entry)·live schema 캐시·계약 해시 검증 전부를
무상 재사용**한다(Bun/RN와 동일 조합, 리서치 §7.1). 이것이 "코어 계약 소유"
전략의 wasm 판이다.

### 5.3 이벤트 — pollMs 패턴 이식(731bbae9 선례)

- `rustra_wasm_take_pending_events`(§3.3)을 drain 원천으로, RN
  `react-native-events.ts:94-116`의 폴링 소비자 패턴(인스턴스당 타이머 1개,
  마지막 구독 해제 시 정지, drain 실패는 로그)을 이식한다. `pollMs` 기본값은
  명시적 요구 시에만 폴링이 켜지도록(기본 off — RN과 동일 정책) 하되, 이벤트를
  쓰는 앱의 온보딩 마찰을 줄이기 위해 `subscribeEvent` 사용 시점 자동 가동을
  슬라이스에서 A/B 검토한다.
- 백그라운드 탭 타이머 스로틀로 폴링이 느려질 수 있다(미확인 외부 사실).
  실시간성 요구 앱은 Worker+짧은 pollMs 또는 후속 푸시 트랙(§10)으로 안내한다.

## 6. 로드/인스턴스화 수명주기 — BootstrapState 정합

`BootstrapState` 3종(bootstrap-lifecycle.ts:15 — `initializing | ready | disposed`,
dispose 멱등/dispose 후 ready loud-fail)을 그대로 준수한다. 4호스트 전부가 이
상태 머신을 공유하는 매트릭스 계약(compatibility-matrix.md:106-125)의 5번째
인스턴스다:

| 상태           | wasm 진입 조건                                                                                                                                                | 실패 시                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `initializing` | 모듈 컴파일/스트리밍 fetch + `WebAssembly.instantiate` + exports 표면 검증(§5.2 4식 존재 + memory)                                                            | 원본 에러 reject, 상태는 `initializing` 유지(bootstrap-lifecycle.ts:12-13 규칙 — 벽돌화 금지) |
| `ready`        | 엔진 생성(`createRkyvV2Engine`) + `contractHash` 옵션 지정 시 해시 검증(`getContractHash` → 기존 F5 검증 경로 재사용, 리서치 §7.1) 통과                       | —                                                                                             |
| `disposed`     | `dispose()` — JS 참조 해제. WebAssembly엔 명시적 티어다운 API가 없어 인스턴스는 GC에 맡긴다(계약 문서에 명시 — "dispose 후 메모리 회수는 가비지 컬렉션 시점") | 두 번째 dispose는 no-op                                                                       |

- **reload(hot-swap)**: 기기에서 mid-run 스왑이 증명됐다(리서치 §1.3). "새
  .wasm 재컴파일 → 새 인스턴스 → 상태 이관"의 `reload()`는 후속 슬라이스(§9)로
  미룬다 — 1차는 dispose+신규 bootstrap으로 충분하다.
- 엔진 슬롯 계약(단일 엔진, registry.frozen — compatibility-matrix.md:58-60)은
  기존 `configureLazy`/registry 메커니즘 그대로 상속한다.

## 7. EngineSupports 값 + 매트릭스 갱신 방향

### 7.1 `WASM_ENGINE_SUPPORTS` (1차 확정값)

```ts
export const WASM_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'pre-abort', // dispatch 전 abort만 관측 — 동기 호출엔 in-flight가 없음 (§2.2)
  batch: 'per-entry', // createRkyvV2Engine의 invokeBatch가 항목별 invokeRkyvV2로 실행
  events: 'polling', // rustra_wasm_take_pending_events 폴링 drain
  channels: false, // 1차 non-goal — 콜백 import 후속 트랙
  timeoutPreemption: false, // 동기 export는 실행 중 선점 불가 (RN JSON과 동일 셀)
};
```

각 셀은 compatibility-matrix.md의 셀 패밀리와 1:1이어야 한다(공개 API가 문서의
타입화라는 A02 원칙, public.ts:6-10). `batch`의 `single-crossing` 승격은 wire
배치 export 필요(오픈 질문 §10).

### 7.2 매트릭스·문서 갱신 방향

1. `docs/compatibility-matrix.md` — 신규 "wasm(JS WebAssembly)" 호스트 행/열:
   위 5셀 + 동기 invoke 지원(별도 표기 — 격차 #3의 `invokeTypedSync` 류은
   wasm에선 자명: 엔진 표면 자체가 동기이므로). `invokeBatch semantics` 절에
   wasm 행 추가(per-entry).
2. 증거 수준 표(README + 매트릭스 "Platforms not covered by runtime evidence",
   compatibility-matrix.md:57-61): "브라우저(headless Chromium CI) + Node
   런타임 스모크"를 1차 증거로 추가하고, 기존 "wasm spike's emulator/simulator
   runs" 문구는 RN/wasm3 스파이크 국한으로 정확화한다.
3. `docs/extending/adding-host.md` 의사결정나무에 "브라우저/범용 JS? →
   @rustra/wasm(WebAssembly exports + 선형 메모리 스테이징)" 가지 추가.
4. release guard(compatibility-matrix.md:209-213): **유지**. `@rustra/wasm`은
   JS 전용 배포물이라 `*.wasm` 배제 규칙과 무충돌 — dev-only wasm 백엔드(wasm3)
   규정은 그대로 살아있다. 버전 발행은 versioning-policy 0.x 마이너 레인 +
   changeset(`@rustra/wasm` minor, 최초 0.8.x 진입).

## 8. 바이너리 크기 예산과 측정 방법

- **예산(1차 상한)**: 발행 검증 시점 gzip ≤ **300 KiB** (raw 기준 ≤ 1.2 MiB).
  근거: 2-커맨드 엔진 실측 raw 881 KiB/gzip 217 KiB(리서치 §6.4)에 명령 30개
  수준(calculator 예제)의 증가분 여유. 상한 초과는 게이트 실패가 아니라
  **회귀 리뷰 트리거**(벤치 게이트 관례 — 크기는 계약이 아니라 예산).
- **측정 방법(재현 가능)**: 코드젠/dev 오케스트레이션이 wasm 산출을 공지하는
  지점(A3 `[dev:wasm] engine artifact: <path>`)에서 `ls -l`(raw)과
  `gzip -9 | wc -c`를 스크립트로 기록 — receipt는 bench receipt 문화
  (docs/benchmark-receipts)와 동일 형식. CI: `rust-wasm32` 잡을
  `cargo build --release` + 산출 크기 receipt 출력으로 강화(§3.5).
- **최적화 경로(후속 슬라이스)**: `wasm-opt`/트리셰이킹/Bulk-memory는 미실측
  (**미확인** — 스파이크 프로파일 opt-level "s"/panic=abort 조합이 현재 유일한
  실측 최적화). LTO/`codegen-units=1` 실험 포함.

## 9. 리스크 목록 + 권장 슬라이스 순서

### 9.1 리스크

| #   | 리스크                                                                    | 완화                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | async fn Pending → busy-spin(호출 스레드 영구 점유, 리서치 §2.2)          | 지원 계약 명문화(§3.4) + doctor 경고 강화 + 오픈 질문(Q1)                                                                                                                    |
| R2  | memory.buffer grow 후 stale 뷰 → 잘린 응답/오독                           | glue가 매 호출 뷰 재취득(스파이크 5단계) + 대형 페이로드 왕복 테스트                                                                                                         |
| R3  | 메인 스레드 블록(긴 핸들러)                                               | `timeoutPreemption:false` 정직 노출 + Worker 권장 가이드                                                                                                                     |
| R4  | 크기 드리프트(rustra 0.5.0 기록 848 KB → 0.8.0 실측 881 KiB, 리서치 §6.4) | §8 receipt + 예산 상한 리뷰                                                                                                                                                  |
| R5  | free/unstage 오용(누수·double-free)                                       | debug free_guard 계약 그대로 적용(트랩으로 조기 발견) + glue 계약 테스트(Bun 패키지가 FFI caller-buffer 계약의 유일 자동 검증이던 선례 — ci.yml:249-253 교훈: 게이트로 승격) |
| R6  | 폴링 이벤트의 지연/백그라운드 스로틀                                      | pollMs 문서화 + Worker 안내; 푸시(콜백 import)는 후속                                                                                                                        |
| R7  | 게이트된 wasm 코드의 네이티브 클래퍼 사각                                 | §3.5 미러링 전략(공용 본문은 네이티브 단위테스트)                                                                                                                            |
| R8  | 구형 환경 호환(BigInt/i64, bulk-memory 등)                                | 지원 기준선(예: ES2020+)을 패키지 문서에 명시 — 슬라이스에서 확정                                                                                                            |
| R9  | 손수 glue 장기 유지비(웹 API 연동 요구 증가 시)                           | import 객체 확장 여지 설계(§10 Q5); wasm-bindgen 재평가 트리거를 문서화                                                                                                      |

### 9.2 권장 슬라이스 순서 (방향 제시 — 구현 계획은 별도 문서)

1. **S1 코어 wasm 표면** — §3.1 스테이징 ABI 2 export + §3.2 async 즉시 실패
   프레임(deliver_spawn_failure 재사용) + §3.3 drain export, 전부
   cfg(target_family="wasm"). 검증: `cargo check/build --target
wasm32-unknown-unknown` + 스파이크 백엔드 경유 Node 런타임 왕복(바이트 동일
   PINNED 게이트 선례 적용).
2. **S2 `@rustra/wasm` 패키지** — §5 glue + `createWasmBootstrap` + WASM_ENGINE_SUPPORTS
   - 계약 테스트(실 .wasm 로드, R2/R5 시나리오 포함). RustraErrorCode 확장.
3. **S3 코드젠·CLI 연결** — `generated/wasm.ts` 엔트리포인트(§5.1 팩토리 주입,
   bun.ts/react-native.ts와 동일 패턴) + dev.target="wasm" 산출 경로를 부트스트랩
   기본 후보로 연결.
4. **S4 이벤트 폴링** — §5.3 subscribeEvent(pollMs 이식) + 테스트.
5. **S5 증거·문서·발행** — headless 브라우저 + Node CI 스모크, 크기 receipt
   게이트(§8), 매트릭스/README/adding-host/rust-api-guide(§3.4·§7.2) 갱신,
   changeset.
6. **후속(별도 트랙)** — reload(hot-swap), 채널(콜백 import 설계), Worker 공식
   가이드, wasm-opt/LTO, wire 배치 export(single-crossing 승격 검토), 푸시
   이벤트(import) 재평가.

## 10. 오픈 질문

1. async-fn "첫 poll 완결" 요구의 정적 검사 가능성 — 매크로가 await 지점 존재를
   진단할 수 있는가(경고 수준)? (§3.4)
2. 이벤트 drain export의 범용화 — wasm 게이트가 아니라 전 호스트 공개로 올려
   Node one-shot 호스트의 커스텀 `__drainEvents` 구현을 대체할 가치가 있는가?
3. `single-crossing` 배치 — wire 배치 export(rustra_dispatch_batch 선례,
   compatibility-matrix.md:103-104)의 wasm 버전을 몇 슬라이스 뒤에 검토할 것인가.
4. 채널 콜백 import 설계 — wasm import 함수 테이블(호스트 JS 콜백)의 안전한
   수명 관리(unregister 시점, quiescence 계약의 import 판) — 후속 트랙 설계 과제.
5. import 객체 확장 포인트 — 향후 브라우저 API 연동(web-sys 대체)이 필요할 때의
   import 계약 설계(지금은 빈 import로 인스턴스화).
6. 지원 기준선 확정 — ES2020+/최소 브라우저 버전 표(R8)와 Node `WebAssembly`
   요구 버전 표기.
7. wasm-opt/LTO 실험 결과에 따른 예산 재조정 시점(§8).

## 정합성 셀프체크

- 격차 #1 정의 충족: 브라우저 실행 표면 + 범용 JS 환경 + 발행 패키지(§1, §5, §7).
- 기존 자산 최대 재사용: sync FFI 심볼·free_guard·EventBus·createRkyvV2Engine·
  생성 코덱·BootstrapState·dev 오케스트레이션 전부 재사용(신규 Rust export는
  3개뿐 — §3).
- 성향 정합: 의존 0 추가(wasm-bindgen 미도입, §4), 계약 문서화·정직한
  EngineSupports(§7), 증거 수준 표 갱신(§7.2), 게이트/레셉트 문화(§3.5, §8).
- 병행 트랙 무충돌: wasm3/RN dev 백엔드 규정·release guard 유지(§1.2, §7.2),
  Electron·역방향 콜백 트록과 독립(non-goal 명시).
