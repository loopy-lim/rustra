# 네이티브 핫스왑 dev hot-core 설계 (2026-09-09)

상태: 설계 확정(사용자 승인 — "simulator에서만 된다고 해도 진행"). 배경:
무재시작 동적 개발 1차 조사(`2026-09-07-wasm-host-design.md` 계열)에서 wasm
dev core 경로를 권고했으나, 사용자가 **네이티브 dylib 핫스왑 + 재빌드 단축**
방향을 선택했다. 본 문서는 2차 검증(웹 4건 + 저장소 FFI 표면 확인) 결과를
설계로 확정한다.

## 문제

Rust `#[command]` 로직을 고치면 호스트별로 전부 정체 상태가 된다.

- **Tauri** — 코어가 앱 바이너리에 cargo 정적 링크라 `tauri dev`가 앱 프로세스
  kill+rebuild+재실행한다. 공식 핫스왑은 없고(tauri#12957 무대응).
- **RN** — 코어가 `librustra_bridge.so`(CMake IMPORTED STATIC)/iOS lipo
  static archive에 박혀 네이티브 재빌드+재설치가 필요하다.
- TS/코드젠 계층은 이미 무재시작이다(`rustra dev` watch → Vite HMR / Metro
  Fast Refresh; ReloadStressApp이 30사이클 JSI 재설치 안전성 입증). 막힌 것은
  Rust 로직 계층 하나뿐이다.

## 플랫폼 근거 (2026-09 검증 확정)

| 대상                           | 프로세스 내 dylib 스왑 | 메커니즘 / 블로커                                                                                                                                                                             |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64                    | ✅                     | 버전화 카피+dlopen, **dlclose 금지**(std TLS로 언로드 자체가 no-op — libloading #59, dyld man 3), 카피 ad-hoc 재서명(cargo 산출물은 linker-signed, 카피는 재서명 필요 — hot-lib-reloader #15) |
| Android 에뮬+**미루팅 실기기** | ✅                     | SELinux `untrusted_app_all`이 `app_data_file`에 `execute`+`map` 허용(targetSdk 29+ 포함 — AOSP sepolicy). 금지는 `execve`와 W+X 자기수정뿐. **유니크 파일명+SONAME** 필수(bionic 경로 캐시)   |
| iOS 시뮬레이터                 | ✅                     | AMFI 부재·컨테이너 writable — InjectionIII 방식 dlopen+dlsym. rustra는 스위즐 불필요한 디스패치 구조라 단순                                                                                   |
| iOS 실기기                     | ❌                     | 라이브러리 검증 상시(HotReloading #97) — **스코프 외**, 정적 루프 유지                                                                                                                        |

## 개요 결정 5줄

1. **FFI 표면 불변** — 코어 경계는 기존 blob C ABI(`ffi_dispatch.rs` —
   `(*mut u8, out_len)` + `with_panic_guard`)를 그대로 스왑 단위로 삼는다.
   계약 정합 판정은 기존 `rustra_ffi_contract_hash`·명령별 와이어 시그니처로
   한다. 신설 네이티브 표면 없음.
2. **호스트 측 로딩 프리미티브 `hot_core`** — `DylibCore`(libloading)와
   `JsonDispatch` 트레잇을 rustra 크레이트에 신설한다(feature `hot-core`,
   tauri 비의존 — Bun 등 타 호스트 재사용). Tauri `tauri_support`는
   `RustraState`를 `Arc<dyn JsonDispatch>` 홀딩으로 바꿔 `rustra_dispatch`
   공개 표면을 유지한 채 스왑 가능하게 한다.
3. **조율은 CLI, 앱은 파일 감시** — `rustra dev` dylib 타깃이
   codegen→cdylib 빌드를 오케스트레이션하고 wasm과 **같은 parity 게이트**로
   무조정 스왑을 거부한다. 앱은 `RUSTRA_HOT_CORE` 환경변수가 가리키는
   아티팩트를 폴링해 스왑한다(truce 레시피: 버전 카피 → macOS 재서명 →
   dlopen → 핸들 leak). HTTP/WS 신호 채널 신설 없음.
4. **TS 파이프라인 확장** — `dev.target: "dylib"` 신설(dev-wasm 선례 미러:
   `dev-config.ts` 해석 + `dev-dylib.ts` 빌드 헬퍼 + parity 게이트 공유).
   빌드된 아티팩트 경로를 안내해 `RUSTRA_HOT_CORE`로 앱을 띄우는 것이
   오케스트레이션의 끝이다(wasm의 "기기 푸시는 호스트 영역"과 동일 경계).
5. **iOS 실기기 스코프 외** — RN 시뮬레이터/Android(에뮬+실기기) 변형은
   후속 슬라이스(Phase 3), Node는 기존 respawn(`NodeBootstrap.reload()`),
   Bun은 dylib 경로 파라미터화만.

## 메커니즘

### 스왑 시퀀스 (앱 측, `hot_core`)

1. 폴링(기본 300ms)으로 `RUSTRA_HOT_CORE` 아티팩트의 mtime+sha256 변화 감지.
2. 카피 생성: `<stem>-hot-<counter><ext>` — 같은 경로 재 dlopen은 캐시 히트로
   구 매핑 반환(libloading #59)이므로 반드시 신규 경로다.
3. macOS: `codesign --force --sign -` 재서명(실패는 loud 에러).
4. 새 `DylibCore::open` — Bun 어댑터와 동일한 초기화 시퀀스로 코어 내부 글로벌
   패키지를 구성하고 디스패치·컨트랙트 해시 심볼을 바인딩한다.
5. 스왑: `HotCoreHandle` 내부 `RwLock<DylibCore>` 교체. 구 Library는
   **절대 dlclose하지 않고 leak한다**(macOS TLS 언로드 불가 + 구 심볼
   use-after-unload 방지 — 세션당 소량 누수는 dev 감수).
6. 스왑 보고: 신구 컨트랙트 해시를 콜백으로 전달한다. Tauri 호스트는
   webview 이벤트로 노출한다.

### 상태·게이트 정책

- **상태 소실** — 스왑이 코어 내부 상태(채널/리소스 테이블, 이벤트 루프)를
  버린다. dev 감수 정책이며 `rustra_ffi_schema_generation` 카운터로 JS 측
  동적 캐시 재동기화 신호를 댄다. drain 의미론은 `NodeBootstrap.reload()`
  선례를 따른다.
- **무조정 스왑 거부** — parity 게이트는 CLI(dev.ts) 소재를 유지한다.
  스키마 해시가 코드젠 전후로 어긋나면 reload 자체를 방출하지 않는다(호스트가
  구 엔진 유지 — wasm 타깃에서 입증된 fail-closed). 앱 측은 판정에 필요한
  정보가 없으므로 판정하지 않는다.
- **스왑 가능 변경의 경계** — 로직 변경(시그니처 불변)은 자유 스왑. 계약
  변경은 codegen이 TS를 갱신한 뒤에만 통과한다. RN 변형(Phase 3)은 생성 C++
  코덱스가 앱에 정적이므로 "시그니처 불변 로직 변경" 한정으로 더 좁다.

## 단계

- **Phase 1 (본 슬라이스)** — `hot-core` 프리미티브(`DylibCore`,
  `HotCoreHandle`, 감시) + `tauri_support` 디스패치 간접화 +
  `rustra dev` dylib 타깃 + calculator cdylib 통합 테스트 + tauri-calculator
  예제 `RUSTRA_HOT_CORE` 모드.
- **Phase 2** — Bun 어댑터 버전 경로 파라미터화, Node 표면 통일.
- **Phase 3** — RN dev 변형 템플릿: Android(앱이 files 디렉토리로 복사 후
  dlopen — 전달은 run-as push/Metro fetch)·iOS 시뮬레이터. JSI HostFunction은
  C++ 셸 소유 유지, 함수 포인터 테이블 재지향만으로 JS 재바인딩 없음.
- **Phase 4** — subsecond 재평가(dioxus#5778 — Tauri lib+bin 레이아웃 빈 패치
  버그 — 해결 시), cranelift 재검(macOS unwind 지원 시).

## 대안 검토 (기각 사유 보존)

- **wasm dev core** — 폴백 경로로 유지. iOS 실기기 커버가 필요해지면 재채택.
- **subsecond** — 워크스페이스 패칭은 착지(dx ≥ 0.7.4)했으나 Tauri lib+bin
  레이아웃에서 조용히 빈 패치(#5778, 2026-08 오픈) + dx 강제 종속.
- **hot-lib-reloader** — 0.8.2(2025-08) 이후 정체, macro 제약. 수동
  libloading+폴링이 truce.audio 프로덕션 레시피로 더 문서화가 좋다.
- **cranelift backend** — macOS에서 unwind 미지원(panic=abort) → FFI 경계의
  `with_panic_guard`를 무력화한다. 스왑 dylib에 부적합.
- **sccache/mold/lld** — 증분+dylib 캐시 불가 / Mach-O 미지원 / 기본 링커보다
  느림. 이 루프와 무관. 워치는 bacon/watchexec(cargo-watch 아카이브됨).

## 리스크/한계

- 스왑 시 코어 상태 소실(위 정책) — 세션 중 채널 핸들은 재수립 필요.
- 폴링 지연 ≤ poll 간격 + cargo 빌드 시간. 목표 루프 **0.5~2초**(warm).
- Android 실기기는 앱이 복사한 `app_data_file` 경로만 유효 —
  `/data/local/tmp`·Downloads 직접 dlopen은 exec 권한 없음(Phase 3에서 경로
  설계 반영).
- 릴리스 빌드는 무관: `hot-core`는 dev 전용 표면이고 릴리스 코어는 기존 정적
  링크 경로를 그대로 간다.

## 구현 상태 (2026-09-09, Phase 1)

- **Phase 1 착지** — `hot-core` feature, `DylibCore`/`HotCoreHandle`, 버전화
  카피 + macOS ad-hoc 재서명, 감시는 **sha256 전용 폴링 300ms**다. 본 문서의
  "mtime+sha256"과의 의도적 이탈이며(변경 감지 기준을 파일 바이트 해시 하나로
  단순화) 기능상 충분하다.
- **CLI dylib 타깃 + 공유 parity 게이트** — `rustra dev`의 `dev.target: "dylib"`
  이 cdylib 빌드를 오케스트레이션하고 wasm 타깃과 같은 parity 게이트를 공유한다.
- **calculator cdylib 통합 테스트** 착지.
- **parity 게이팅의 fail-closed 복원 — 게이트 통과 뒤에만 live 아티팩트 발행**
  — CLI는 `<stem>-hot-live<ext>`를 temp+원자적 rename 으로 발행하며, 이는
  parity 게이트 통과 **이후에만** 일어난다. 게이트 reject 시 기존 live
  아티팩트는 그대로 남아 호스트가 구 엔진을 유지한다.
- **Phase 2 착지(부분) — 웹뷰 스왑 보고** —
  `tauri_support::register_dispatch_with_swap_events(dispatch, reporter, builder)`
  - `HotSwapReporter`: 감시 스레드의 스왑 결과(성공/실패 모두)가
    `rustra://hot-core/swapped` 예약 채널로 웹뷰에 push 된다(싱크는 코어 바깥
    호스트 측에 살아 스왑을 생존 — 상태 소실 정책과 무충돌). JS 측은
    `@rustra/tauri` 의 `subscribeHotSwap`. 페이로드에 구·신 컨트랙트 해시를
    함께 실으므로 **JS 캐시 재동기화 신호를 이벤트가 대행**한다 —
    `rustra_ffi_schema_generation` 카운터는 도입하지 않기로 확정(수신 측이 해시
    비교로 재호출 여부를 판단).
- **미착지(Phase 2 잔여)** — Bun 어댑터 버전 경로의 1급 파라미터화.
  단, `RUSTRA_BUN_LIBRARY` 환경변수로 live 아티팩트 경로 지정이 이미 가능해
  실질 블로커는 아니다(2026-09-09 재확인). Node 는 기존 respawn
  (`NodeBootstrap.reload()`) 유지.
- **웜루프 실측 (2026-09-09, `docs/plans/2026-09-09-hot-core-loop-bench.md`)** —
  수정→발행→스왑 전체 p50 **≈3.5초**(n=40, M1 Max, 웜 캐시)로 목표 0.5~2초
  미달. 병목: codegen 의 cargo 단계 ≈2.1초(60%), 스왑 ≈0.93초(폴링 평균
  150ms + dlopen/초기화) — 폴링 간격 축소의 수득은 작다. 실측 과정에서 정식
  `rustra.hot.json` 흐름의 codegen 버그 2건이 발견돼 수선됐다(node/bun 호스트
  섹션의 `codegen.rustManifest` 폴백 + Rust bin 의 `RUSTRA_SCHEMA_OUT` 을
  config 스키마 디렉터리로 고정 — 수선 전엔 이 레이아웃에서 패리티 게이트가
  stale 스키마를 읽어 무력화됐다).
- Phase 3(RN 변형 템플릿)·Phase 4(subsecond/cranelift 재평가)는 미착지.
  Phase 3 전제(앱 도메인 dlopen·duplicate SONAME 병존)는 아래 시뮬레이터
  실측으로 입증됐다.

### 스왑 시나리오 실측 (2026-09-09, `examples/hot-core-variant`)

"스왑 가능 변경의 경계" 절을 변형 cdylib(`examples/hot-core-variant`,
feature 조합이 곧 시나리오)로 3 플랫폼에서 실측했다 — macOS 호스트와 iOS
시뮬레이터(`simctl spawn`), Android 에뮬레이터(`adb shell`)에서 **완전히 동일한
관측**:

| 시나리오 (feature)                                | 계약 해시 | 스왑 후 관측 (`PROBE OBS`)                                                                         |
| ------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| 로직만 변경 (`behavior`, 본문 +100)               | **불변**  | 스왑 즉시 `addNumbers` 값 5→**105** — 시그니처 불변 로직 변경은 자유 스왑이며 실제 데이터가 변한다 |
| 명령 추가 (`add-cmd`)                             | 변함      | `multiplyNumbers ok` — 새 명령이 같은 스왑 1회에 서비스된다                                        |
| 이름 변경 (`rename-cmd`, addNumbers→addNumbersV2) | 변함      | `addNumbers err command.not_found` + `addNumbersV2 ok` — 구 이름 소멸과 신 이름 등장이 동시 반영   |
| 시그니처 변화 (`sig-change`, 인자 `c` 추가)       | 변함      | 구 시그니처(`{a,b}`) 호출은 크래시/기본값 없이 `command.invalid_args` 로 와이어 거부               |

해석: **코어 레벨은 모든 변경을 스왑으로 반영**하고(앱은 판정하지 않는 설계),
계약이 변하는 시나리오(2~4)의 정합 보장은 CLI parity 게이트의 몫이다 —
코드젠이 TS를 갱신하기 전의 계약 변경 빌드는 게이트가 발행을 거부해 실행 중
호스트가 구 코어를 유지한다(fail-closed). 계약 해시는 스키마에서만 나오므로
파일 바이트 해시와 분리돼 있다(시나리오 1에서 바이트는 다르지만 해시 동일).

### 시뮬레이터 실측 (2026-09-09, `examples/hot-core-probe`)

본 문서의 플랫폼 규거 표를 같은 날 실측으로 재확인했다. 검증기는 단독 실행
바이너리 `rustra-hot-core-probe`(동기: open→invoke→에러 분할→해시→버전 카피→
스왑→구 코어 생존 / `--watch N`: sha256 폴링 스왑)다.

| 타깃                                                 | dlopen+디스패치 | 버전 카피+스왑 | 감시 스왑 | 비고                                                                                                                                                                      |
| ---------------------------------------------------- | --------------- | -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64 (호스트)                                 | ✅              | ✅             | ✅        | ad-hoc 재서명 경로                                                                                                                                                        |
| iOS 시뮬레이터 (aarch64-apple-ios-sim, iOS 26.2)     | ✅              | ✅             | ✅        | 앱 내 재서명 불필요 — `cfg(target_os="macos")` codesign 단계는 시뮬레이터에서 시도되지 않으며 linker-signed/호스트 재서명 카피 모두 로드된다                              |
| Android 에뮬레이터 (aarch64-linux-android, API 36.1) | ✅              | ✅             | ✅        | shell 도메인(`/data/local/tmp`)                                                                                                                                           |
| Android 앱 도메인 (`untrusted_app`, targetSdk 35)    | ✅              | ✅             | —         | 앱 `filesDir` 복사본 `System.load` 성공 + **duplicate SONAME 동시 로드 성공** — bionic 은 경로 기준 로드라 버전 카피의 공유 SONAME 이 충돌하지 않는다 (Phase 3 전제 실증) |

- **Tauri 예제 모바일 레이아웃** — tauri-calculator 를 lib/bin 분리
  (`lib.rs` + `mobile_entry_point`, `staticlib`/`cdylib`/`rlib`)으로 전환하면
  iOS 시뮬레이터 빌드·설치·핫 모드 진입(`SIMCTL_CHILD_RUSTRA_HOT_CORE`)·앱 내
  감시 스왑이 모두 동작한다. bin 전용 레이아웃은 `no library targets found`
  로 모바일 빌드 자체가 실패한다(전환 전 실측).
- **매핑 파일 제자리 덮어쓰기 금지(실측)** — 프로세스가 dlopen 한 dylib 파일을
  같은 경로로 덮어쓰면 macOS/iOS 는 `SIGKILL`(서명 코드 변조), Android 는
  `SIGSEGV`(수정된 파일 페이지 재로딩)다. 정상 흐름은 안전하다 — CLI 발행은
  rename(기존 inode 보존)이고 감시 카피는 고유 경로다. 모바일 전달 계약도
  동일하게 **tmp push + rename** 이어야 한다(README 에 기록).
- `simctl spawn` 에서의 env 전달은 `SIMCTL_CHILD_` 접두사가 필요하다.
