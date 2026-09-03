# Changelog

이 프로젝트의 주요 변경사항을 기록합니다. 세부 내역은 git history와
`docs/plans/`의 계획/결과 문서를 참고하세요.

## Unreleased

### Removed

- deprecated `RendererHost` 표면을 제거한다(0.6.0에서 폐기, pre-1.0 규칙에 따른
  마이너 제거): `crates/rustra`의 `renderer_host` 모듈과 prelude 재노출
  (`RendererHost`, `HostMessage`, `MessageKind`, `RendererCapabilities`, `Size`,
  `SurfaceOptions`, `host_supports_eval`). 대체재는 호스트별 어댑터 경계 —
  채널·FFI 공개 표면으로 임베딩 호스트가 자체 렌더러/이벤트를 연결한다. npm
  0.7.0 라인과 다음 `rustra` crate 발행에 반영된다.

### Changed

- CLI codegen/dev 경로를 책임별 모듈로 분리하고, 잘못된 설정·레이아웃·기존 파일
  덮어쓰기를 조기에 진단한다.
- 생성물 drift 게이트, schema diff, Rust command 문서의 TypeScript JSDoc 전달,
  opt-in `RUSTRA_DEBUG` wire 진단을 보강했다.

## 0.6.0 (2026-08)

0.6은 Rust crate 라인(`rustra`/`rustra-macros` 0.5 → 0.6)의 안정화 트랙이다.
`rustra.json`에 `$schema`·`dev`·`inspector` 선택 섹션이 추가되고, `@rustra/cli`가
배포하는 JSON Schema로 에디터 자동완성·검증을 받는다. `rustra doctor`는 멀티
타깃 상태 매트릭스와 빌드 검증(`section.*.build`)을 갖춘다 — 깨진 Rust 설정이
이제 exit 1이 된다(계획이 필요한 유일한 동작 변경). 와이어 포맷·contract
hash·FFI 표면은 그대로며, API 스냅샷 게이트와 골든 fixture로 하위호환이 관례
대신 게이트로 강제된다. 세부는 packages/*/CHANGELOG.md 및
docs/migrations/0.5-to-0.6.md 참고.

## 0.3 → 0.5 요약

루트 버전 태그는 0.2.0 이후 패키지별 독립 릴리스로 운영된다. 세부 내역은
각 `packages/*/CHANGELOG.md`와 `git tag`(`@rustra/*@0.3.0` ~ `0.5.0`) 참조.
여기서는 0.2.0 이후 소비자가 알아야 할 최소한의 궤적만 요약한다.

### 0.3.0 — 타입 패리티 1단계 + 채널/리소스

- fast-path 타입 확장: uvar/bytes/map/tuple이 TS·Rust·C++ 3면 코드젠에서 일관
  (f36cf983).
- 타입 패리티 2단계 — Tauri v2 `ipc::Channel`·Resource 모델 채널/리소스 지원
  (fa6bd00b). u32 핸들은 기존 uvar 와이어를 그대로 재사용한다.
- `@rustra/testing` 계약 게이트, `@rustra/react` 훅 개선 등 성장 후속.

### 0.4.0 — 멀티호스트 zero config (#42)

- Node/Bun/Tauri/Expo/bare RN 생성 진입점이 lazy zero-config bootstrap을
  소유한다. 호출부가 엔진을 직접 `configure()`하지 않는다.
- JSI byte 전용 경로의 수명/복사 안전화, 호스트 벤치 영수증, Bun 1.4 고정.
- 공개 패키지와 crate가 0.4로 lockstep 동기화되었다.

### 0.4.1 → 0.5.0 — 복합 codec + bigint postcard fast-path (와이어 변경)

- 0.4.1(#44): 스키마 기반 복합 바이너리 codec을 생성 클라이언트가 export.
  독립 패키지 릴리스 라인 확정.
- 0.5.0(#45): **와이어 변경 (stale codec 혼용 시 breaking)** —
  - `int64`/`uint64` 필드가 complex codec 폴백 대신 postcard fast-path로
    라우팅된다. 튜플/와이드 정수 명령의 와이어가 0.4.1과 다르다 — TS 코덱과
    재생성된 Rust를 혼용하면 디코딩이 조용히 깨지므로 **양쪽을 함께
    재생성**해야 한다.
  - safe 정수(±2^53) 밖 값은 `bigint`로 복원된다. TS 타입 표면이
    `i64`/`u64` 필드에서 `number` → `number | bigint`로 넓어진다
    (`number`만 쓰던 호출부는 그대로 동작한다).
  - `Vec<u64>`, `HashMap<String, u64>`, `Option<i64>` 등 복합 타입도 원소
    레벨 64-bit 헬퍼 fast-path를 사용한다.

## 0.2.0 (2026-08-20)

### Removed

- **Lynx 지원 제거** (PR #16, breaking) — `@rustra/lynx` npm 디프리케이트,
  Lynx 예제/runner 템플릿 삭제. rustra는 Node/Bun/Tauri/React Native 4표면에
  집중한다. rkyv V2 바이너리 fast-path는 RN JSI 어댑터와 공유라 영향 없음.

### Added

- **코드젠 정확성 마감** (PR #17): rkyv postcard 코덱이 미지원 필드를 무음
  삭제하던 결함 수정 — `Option<T>`/`Vec<String>`/`Vec<Struct>`/string enum이
  정확히 인코딩된다(바이트 정합 round-trip 검증). 진짜 미지원 타입은 생성 시
  `WARN`과 함께 레지스트리에서 제외되어 Tier 3 JSON 폴백으로 라우팅(부분 코덱
  선점 제거). `allOf` intersection, integer enum 리터럴 유니언 지원(dual-path).
- **`InvokeOptions.timeoutMs`** (PR #29) — `transport.timeout`(retryable)
  타임아웃 레이스. 네이티브 무응답(hang)의 JS 측 탈출구. 스키마 식별자
  화이트리스트로 생성 코드 주입 방어, napi 경로 에러 code/retryable JSON 보존.
- Node/Bun 엔진의 signal 정책 완결(PR #29 문서 고정 → 0.2.x 초반 확정):
  abort된 signal만 `cancelled`, 미abort는 정상 실행(아래 Changed 참조).

### Changed

- **`useCommand`/`useMutation`/`mock()` minify-안전 식별** — 코드젠이 명령
  함수에 `commandId` 프로퍼티를 심고, `resolveCommandId()` 헬퍼가 이를 우선
  읽는다. 번들러 mangling으로 `Function.name`이 바뀌어도 `command.not_found`가
  발생하지 않는다.
- **JSON 엔진(Node/Bun/Tauri) signal 정책 통일** — 미abort signal을 넘겨도
  더 이상 `cancel.unsupported`로 즉시 거부하지 않는다(얕은 취소). abort된
  signal의 `cancelled` 거부는 유지. `useCommand` 조합이 첫 호출부터 실패하던
  결함 해소.
- **devtools instrumented 엔진이 options 보존** — 관측 래핑이
  signal/timeoutMs를 조용히 버리지 않는다.
- **release 빌드에서 `grant_capability` 동작** — freeze는 레지스트리 구조
  mutation(register/unregister/replace)에만 적용되고, 런타임 권한 부여는
  동결과 무관하게 허용된다(deny-by-default가 deny-forever가 되던 결함).
- **`#[command(capability = "...")]` 속성** — 문자열 이름 재결합
  (`require_capability("name", cap)`) 없이 매크로 시점에 권한 지정.

세부 내역은 패키지별 CHANGELOG(`packages/*/CHANGELOG.md`) 참조.

## 0.1.3 (2026-08-19)

### Added

- `Package::set_event_sink` / `rustra::events::EventSink` — Rust → JS 이벤트
  **푸시** 전달. 싱크를 설치하면 `Package::emit` 이 버스 적재 대신 콜백을
  즉시 호출한다(폴링 불필요, LLM 토큰 스트리밍 등 저지연 용도). 싱크와
  버스는 상호 배타적 — 설치 중에는 `take_pending_events` 큐가 비어 있다
  (이중 수신 방지). `set_event_sink(None)` 으로 즉시 폴링 복귀. 싱크 패닉은
  `catch_unwind` 로 격리되어 emit 호출자로 전파되지 않는다.
- `tauri_support::register_with_events(package, builder)` — Tauri 푸시 배선.
  플러그인 setup 훅에서 `tauri_event_sink` 를 설치해 `Package::emit` 이
  `app.emit_str("rustra://{sanitized}", payload_json)` 로 전달된다. 기존
  `register` 는 폴링 경로 유지(하위호환). 채널명 규칙: 이벤트명의
  영숫자/`-`/`/`/`:`/`_` 외 문자는 `_` 치환(예: `progress.tick` →
  `rustra://progress_tick`).
- `tauri_support::tauri_event_sink(app)` / `tauri_support::event_channel(name)` —
  자체 호스트 setup 흐름에서 싱크를 직접 설치할 때 쓰는 공개 헬퍼(플러그인
  없이 `app.handle().clone()` 만 있으면 된다).
- FFI 이벤트 싱크 — `rustra_ffi_event_sink_register(callback, user_data)` /
  `rustra_event_sink_unregister()`. C 콜백 ABI 는 `extern "C-unwind"`
  (콜백 패닉이 Rust 쪽 catch_unwind 에서 가두어진다). 패키지 등록 전 싱크
  등록도 지원(지연 설치).
- `@rustra/react-native` `subscribeEvent(native, name, cb)` → unsubscribe.
  RN JSI `onEvent`/`offEvent` 위의 TS 래퍼 — 페이로드는 JSON 문자열로 JSI 를
  건너고 TS 에서 `JSON.parse` 1회 복원. `RustraNative` 타입에
  `onEvent`/`offEvent`/`drainEvents` 추가.
- RN JSI 이벤트 콜백 — iOS `.mm`(RCTCxxBridge jsCallInvoker) / Android
  JNI(CallInvokerHolderImpl). emitting 스레드는 고정 용량 1024 drop-oldest
  큐에 적재 + `CallInvoker::invokeAsync(drain)` 예약, drain 이 JS 런타임
  스레드에서 per-name JS 함수 호출. CallInvoker 없는 호스트는 `drainEvents()`
  JS 폴링 폴백. RN 리로드 시 stale 리스너 정리.
- `rustra dev` CLI — Rust 소스 감시 + dual-path codegen 자동 재실행
  (hot codegen). mtime 기반 stale 판정으로 Rust bin/TS CLI 스테이지 선택적 실행,
  `--inspect` 플래그로 devtools 안내
- `@rustra/testing` 패키지 — `createMockEngine` (계약 동일 mock 엔진,
  `.on()` 체이닝 + 호출 기록) + `assertContractCurrent` 계약 게이트
- `@rustra/devtools` 패키지 — `createInstrumentedEngine` 호출 관측성 래퍼
  (명령별 count/errors/avgMs + 슬로우 콜 타임라인)
- `windows-experiment.yml` — lynx.dll export 덤프 + MSVC 빌드 시도 CI (P1 실험)
- `fuzz.yml` + `fuzz/` — cargo-fuzz `invoke_rkyv_v2` 디코드 경로 무작위 입력
  검증 (주 1회 10분 타임박스)
- codegen `Set<T>` 타입 지원 — Rust `BTreeSet`/`HashSet` (`uniqueItems`)이
  `Set<T>`로 매핑. postcard 코덱 `set_zigzag`/`set_f64`/`set_bool` kind
  (와이어는 vec와 호환), JSON 경로 Set replacer
- `RustraCommandError.retryable` — Rust `transport.error`/`transport.timeout`
  생성 에러의 재시도 가능 여부를 TypeScript에서 조회 가능
- `createAsyncEngine` (`@rustra/react-native`) — P0-3 async offload 엔진.
  네이티브 `invokeTypedAsync` 있으면 콜백 큐 경로, 없으면 동기 폴백
- `rustra init <dir>` CLI — 프로젝트 스캐폴딩 (Cargo + echo 예제 + codegen 스크립트)
- Windows desktop 스캐폴드 — `lynx_desktop_win.cpp` + `build.rs` 플랫폼 분기
  (FML 심볼 export/오프셋 확정은 Windows 머신 전제)
- `bench.yml` — criterion 벤치마크 회귀 감지 CI
- `release.yml` — changesets npm 자동 발행 + crates.io 수동 발행 잡
- `verify:desktop`/`verify:ios`/`verify:android` 런타임 게이트 스크립트 (package.json)

## 0.1.1 (2026-08-14)

npm `@rustra/*` 7종(types/cli/node/bun/tauri/react-native/lynx)과 crates.io
`rustra`/`rustra-macros` 첫 공개 발행.

### Added

- rkyv V2 무직렬화 경로 (`invoke_rkyv_v2`) — JSON 대비 15~83× 작은 와이어포맷
- RN JSI fast path + C++ 코덱 (`--cpp-output`) 생성
- Lynx 어댑터 (`@rustra/lynx`) — QuickJS 런타임 지원
- codegen Map/Tuple 타입 지원
- runtime command registry / 동적 rkyv 경로
- invokeBatch (P0-2) 배치 호출
- runner 템플릿 — desktop(macOS Tauri×Lynx) + iOS + Android 플랫폼 셸,
  `create-runner.sh` 인스턴스에이션, capability 계층(File/Notify/Mobile 브리지)
- 크로스 플랫폼 검증: macOS 7/7 · iOS 7/7 · Android 7/7 스파이크 PASS
- 벤치마크: 어댑터/transport/온디바이스 실측 (iOS Direct C++ 0.95µs — Nitro 1.10µs 대비 우위)
- FFI trust hardening — 패닉 격리(catch_unwind), debug allocation tracker,
  null out_len 가드, contract hash 검증

### Changed

- 저장소 URL을 `loopy-lim/rustra` → `loopy-lim/hostra`로 정리 (2026-08-20 `loopy-lim/rustra`로 환원 — hostra 개명 철회)

## 0.1.0 (2026-05-13)

초기 버전 — Rust macros(`#[command]`/`#[bridge_type]`/`build!`), codegen 파이프라인,
Node/Bun/Tauri/RN 어댑터.
