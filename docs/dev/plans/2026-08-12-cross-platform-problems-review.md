# 크로스플랫폼 문제점 총점검 (Phase 4·5 완료 시점)

- **상태:** Review. Phase 4(Windows 조사)·Phase 5(runner 템플릿) 완료 시점의 잔존 리스크/문제점 총정리.
- **날짜:** 2026-08-12
- **목적:** 4플랫폼 설계의 "문제점들에 대한 확인" (사용자 과제 조건). 각 항목별 현 상태·심각도·다음 액션 명시.

---

## 검증 현황 (회귀 포함)

| 게이트                                    | 결과              | 비고                                                                  |
| ----------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| `test:types`                              | 24/24 PASS        | @rustra/types                                                         |
| `test:ts:node`                            | 32/32 PASS        | adapter/cross-wire/payload/field-order/generated-client               |
| `test:packages`                           | 24/24 PASS        | node/bun/tauri/react-native/**lynx** (getRustraNative 회귀 픽스 포함) |
| `cargo test --workspace`                  | 144 PASS (0 fail) | rustra + macros + examples (trust/fuzz/concurrency)                   |
| `cargo clippy` (spike + template backend) | clean             | `-D warnings` 통과 (본 Phase 변경분)                                  |
| macOS spike 런타임                        | 7/7 PASS          | SetParent NSView + rkyv 왕복 (이전 세션)                              |
| iOS spike 런타임                          | 7/7 PASS          | RustraModule + rkyv 왕복 (이전 세션)                                  |
| Android spike 런타임                      | 7/7 PASS          | JNI_OnLoad init + 3대 갭 해결 (이전 세션)                             |
| Windows 런타임                            | ⏳ DEFERRED       | Windows 머신 필요 (MSVC/PE). 코드·크로스컴파일·계획은 완료.           |

---

## 문제점 카탈로그

### P1. Windows FML 메시지 루프 펌프 심볼 해석 — ★ 크럭스 (미해결, 런타임)

- **현상:** Lynx BTS/runtime 이 `fml::MessageLoop::RunExpired` 를 매 틱 펌프해야 하는데, 이 심볼이 SDK 헤더에 노출되지 않는다.
- **macOS 해결:** Mach-O image-base + 하드코딩 오프셋(0x3ecc=IsInit, 0x43a4=RunExpired, 0x9329bc=UIThreadInit)으로 직접 해석 (`lynx_desktop.mm resolve_liblynx_symbols()`).
- **Windows 미해결:** PE(GetModuleHandleW) 등가 오프셋을 모른다. 3가지 후보:
  1. **GetProcAddress 정식 해결** — 심볼이 export 되어 있으면 가장 깨끗. (확률 낮음: BTS 내부 심볼.)
  2. **PE 오프셋 하드코딩** — macOS 와 동일 기법, 오프셋은 Windows 머신에서 dumpbin/objdump 로 추출.
  3. **windowless fallback** — 펌프 없이 동작하는 경로 탐색 (불확실).
- **심각도:** HIGH (Windows 런타임의 유일한 하드 블로커).
- **다음 액션:** Windows 머신 확보 후 `verify-windows.ps1` 실행 → 후보 1→2→3 순 시도. 설계: `docs/plans/2026-08-12-lynx-windows-phase4.md` "포인트 3".

### P2. ELF/PE 생성자 비대칭 — 패키지 자동등록 (해결됨, 문서화됨)

- **현상:** Rust 패키지의 FFI 레지스트리 등록이 Apple 만 `__mod_init_func` 로 자동. Windows(PE)/Android(ELF) 는 생성자가 없어 명시 init 필요.
- **해결:** 공개 `rustra_*_init()` (OnceLock 로 idempotent) 를 각 플랫폼 셸 로드 시점에 명시 호출.
  - macOS spike: `lynx_spike_init` 시작부에서 `rustra_calculator_init()` 호출 (최근 크로스플랫폼 수정).
  - template: `rustra_template_init()` 노출, create-runner.sh 가 prefix 치환.
  - iOS/Android: JNI_OnLoad / JSI install 시점 호출 (spike 7/7 로 증명).
- **심각도:** LOW (해결됨). 다만 플랫폼 추가 시 "init 을 명시 호출했는가" 체크리스트 필수 — template README·capabilities/README 에 명시.

### P3. NativeModule 위상 차이 — getRustraNative 회귀 (해결됨)

- **현상:** NativeModules 접근이 플랫폼마다 다르다.
  - Mobile(공식 SDK): webpack-wrapper 클로저 변수 (globalThis.NativeModules 비어있음).
  - Desktop host: globalThis.NativeModules.RustraModule + globalThis.RustraModule 에 주입 (full surface, invokeRkyvV2 + ackResult).
  - Desktop Lynx NAPI: 클로저 NativeModules.RustraModule 은 method-map 프록시 (invokeRkyvV2 만).
- **회귀:** 모바일 스파이크(Phase A/B) 중 getRustraNative() 를 "클로저 우선"으로 바꿨더니 데스크톱에서 NAPI 프록시(ackResult 없음)가 가려 ackResult=FAIL. 단위 테스트가 런타임을 안 타서 놓침.
- **해결:** 우선순위를 **globalThis-first, closure-fallback** 으로 복구 (`packages/lynx/src/index.ts`). 3플랫폼 7/7 재검증 + test:packages 24/24.
- **심각도:** LOW (해결됨). **교훈:** 클로저 vs globalThis 우선순위는 런타임 회귀 테스트(desktop verify.sh) 로만 잡힘 — 단위 테스트 불가. capability/플랫폼 추가 시 데스크톱 verify.sh 를 회귀 게이트로 유지.

### P4. schemars 메이저 버전 커플링 (해결됨, 문서화됨)

- **현상:** rustra 가 `JsonSchema` trait 를 schemars 0.8 에서 re-export. 컨슈머가 다른 메이저(schemars 1.x) 를 쓰면 derive 충돌로 빌드 붕괴 (template backend 최초 `schemars="1"` → 20 errors).
- **해결:** template backend Cargo.toml 을 rustra/calculator 가 검증한 핀과 동일하게 (`schemars = { version="0.8", features=["derive","preserve_order"] }`). 코멘트로 경고.
- **심각도:** LOW (해결됨). **근본:** rustra 0.8 → 향후 schemars 1.x 마이그레이션 시 모든 컨슈머 동시 업그레이드 필요 (ABI debt 의 한 형태).

### P5. postcard 필드순서 드리프트 (완화됨, Task 3.5 F7)

- **현상:** postcard 직렬화는 struct 필드 선언순에 의존. Rust 와 TS 양쪽 선언이 어긋나면 조용히 깨짐.
- **완화:** frozen-at-build (빌드 시점 contract 고정) + field-order drift 탐지 테스트(Task 3.5). rkyv V2 wire 는 cmd_id u16 로 명시적.
- **심각도:** LOW (완화됨). 새 struct 추가 시 generated/ 재생성 필수 (codegen 게이트).

### P6. Android NDK 버전 핀 (해결됨 — 2026-08-14)

- **현상:** JNI staticlib 4아키텍처(aarch64/armv7/x86_64/i686) 빌드가 특정 NDK 버전에 민감. rustup target 과 NDK toolchain 정렬 필요.
- **현재:** spike 7/7 로 특정 환경에서 동작 증명. 단, "다른 개발자의 NDK" 에서의 재현성은 미검증.
- **심각도:** LOW (해결됨). runner/template/mobile-android/modules/rustra-lynx/build-rust-android.sh 이 NDK_VERSION 핀(27.1.12297006) + $SDK/ndk/<ver> 결정론 선택 + rustup target 사전 검증을 구현했다. app/build.gradle.kts 도 동일 ndkVersion 핀.

### P7. Template path 의존성 카피아웃 파손 (문서화됨, 설계적)

- **현상:** template backend Cargo.toml 이 `rustra = { path = "../../../crates/rustra" }`. in-repo 검증엔 동작하지만 create-runner.sh 로 외부 디렉토리에 복사하면 path 가 깨짐 (cargo "No such file or directory").
- **의도:** template 은 복사-수정-빌드 시작점. path 는 published crate 또는 로컬 path 로 재작성 전제.
- **심각도:** LOW (설계적). README·create-runner.sh 안내. rustra crate 가 published 되면 version 핀으로 전환 권장.

### P8. Windows 런타임 검증 연기 (정직한 연기)

- **현상:** macOS 에서 MSVC/PE 런타임 검증 불가. Phase 4 = 조사 + 코드 + Rust 크로스컴파일 증명 + 계획. 런타임 7/7 은 Windows 머신에서 verify-windows.ps1 로 수행 예정.
- **심각도:** P1 에 종속 (P1 해결 시 검증 가능).

---

## 요약: 크로스플랫폼 성숙도

| 플랫폼  | 런타임 증명       | 잔존 블로커                 |
| ------- | ----------------- | --------------------------- |
| macOS   | ✅ 7/7            | 없음                        |
| iOS     | ✅ 7/7            | 없음                        |
| Android | ✅ 7/7            | NDK 핀 재현성(P6, 환경의존) |
| Windows | ⏳ 코드·계획 완료 | FML PE 심볼 해석(P1, HIGH)  |

**결론:** 3/4 플랫폼 런타임 증명 완료. Windows 는 단일 크럭스(P1 FML) 만 남았고, 그 외 모든 문제점은 해결·완화·문서화됨. rustra runner 템플릿(Phase 5)은 본 머신에서 `cargo check` + capability 단위 테스트(3 PASS) 로 자체 검증되었고, instantiation(create-runner.sh)은 치환·빌드 게이트까지 확인됨.
