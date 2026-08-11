# Tauri + Lynx + rustra 통합 데스크톱/모바일 아키텍처 설계

- **상태:** Design (스파이크 전 단계). 1차 성공 기준 = 단일 ReactLynx 예제가 4플랫폼에서 동일 rustra 백엔드로 구동.
- **날짜:** 2026-08-11
- **관련 문서:** `docs/research/tauri-like-single-invoke-architecture.ko.md`(single-invoke 철학), `docs/research/lynx-architecture-research.md`(Lynx FFI), `docs/extending/lynx-setup.md`(iOS/Android NativeModule 템플릿), `docs/plans/2026-08-10-lynx-adapter.md`(Lynx 어댑터 구현 계획).
- **후속(impl plan):** `docs/plans/2026-08-11-tauri-lynx-desktop-spike.md`

---

## 1. 배경 및 목표

rustra-bridge는 이미 Rust `#[command]` → TS 클라이언트 자동 생성 → 5 어댑터(Node/Bun/Tauri/RN/Lynx) 구조다. 사용자 요구: **이 단일 스택(Tauri + Lynx + rustra)을 "실제 다른 프로젝트"에 가져가 쓸 수 있는 재사용 runner 형태로 만들 것.**

이 설계의 목표는 단일 ReactLynx UI + 단일 rustra 백엔드가 **Android/iOS/macOS/Windows 4플랫폼**에서 구동되고, 플랫폼 네이티브 capability는 plugin 형태로 확장되는 구조를 정의하는 것이다.

## 2. 확정된 설계 제약 (사용자 결정)

| 축                  | 결정                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| UI                  | 단일 ReactLynx 코드베이스 1벌 (Lynx everywhere)                                                                           |
| 백엔드              | 단일 Rust `#[command]` 셋 (rustra), 4플랫폼 공유                                                                          |
| 백엔드 호출 경로    | `@rustra/lynx` rkyv V2 fast-path 단일 경로 (모든 플랫폼)                                                                  |
| Desktop 셸          | **Tauri** (macOS + Windows). Linux 제외                                                                                   |
| Mobile 셸           | **Lynx 자체 SDK** (Android + iOS). Tauri mobile 미사용                                                                    |
| 네이티브 capability | rustra capability 추상 command → 플랫폼별 구현체(Desktop=Tauri plugin, Mobile=Lynx NativeModule). plugin 형태로 추가/제거 |
| 1차 성공 기준       | 단일 ReactLynx 예제(calculator 수준)가 4플랫폼 구동                                                                       |

## 3. 핵심 근거 (조사 결과)

- **Lynx 3.7 desktop 공식 지원**: macOS/Windows first-class, "C++ API for rendering Lynx inside macOS & Windows apps", Clay 렌더링 엔진. CSS 97% / element 73% 커버리지. ([Lynx 3.7 blog](https://lynxjs.org/next/blog/lynx-3-7))
- **로컬 Lynx SDK 확보**: `/tmp/lynx-prebuilt/` 에 `Lynx-4.0.1`, `macsdk/`(macOS arm64). `host.cpp` 주석의 SDK 4.0/engine 3.2와 정렬.
- **macOS Lynx 렌더링 증명됨**: `examples/lynx-calculator/host/host.cpp` 가 windowless software renderer → NSWindow blit로 구동 + rustra rkyv FFI 왕복 + 이벤트 푸시까지 이미 검증(Phase A 10/10).
- **iOS/Android NativeModule 템플릿 존재**: `docs/extending/lynx-setup.md` 에 Obj-C `RustraModule<LynxModule>` + Kotlin `@LynxMethod` 코드 + `build-rust-ios.sh`/`build-rust-android.sh` 패턴.
- **single-invoke 철학 정렬**: 기존 `tauri-like-single-invoke-architecture.ko.md` 가 "invoke 하나, 내부 transport 선택" — 본 설계의 rkyv 단일 경로 + capability command 추상과 동일 방향. 새 방향이 아닌 기존 철학의 확장.

## 4. 아키텍처: 3계층 + capability 추상

```
┌─────────────────────────────────────────────────────────────┐
│  단일 ReactLynx App  (src/App.tsx — 4플랫폼 공유, 1벌)        │
│  addNumbers()  ·  readFile()  ·  notify()  ·  …             │
└──────────────────────────┬──────────────────────────────────┘
                           │  @rustra/lynx (rkyv V2 fast-path, 단일 경로)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  rustra #[command]  (단일 Rust 백엔드, 4플랫폼 공유)           │
│  ├── 비즈니스 로직      add_numbers()                       │
│  └── capability 추상    read_file() / notify() / …          │
│        trait Cap { fn read_file(..); }   ← 플랫폼 중립       │
└──────────────────────────┬──────────────────────────────────┘
                           │  capability 구현체 주입 (컴파일 타임 플랫폼 선택)
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Desktop             Android              iOS
 ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 │ Tauri 셸     │    │ Lynx SDK 셸  │    │ Lynx SDK 셸  │
 │ +Lynx surf  │    │ (Kotlin)     │    │ (ObjC/Swift) │
 │ Cap =       │    │ Cap =        │    │ Cap =        │
 │ Tauri plugin│    │ Lynx NatMod  │    │ Lynx NatMod  │
 └─────────────┘    └─────────────┘    └─────────────┘
```

**핵심 원칙 4가지:**

1. **단일 UI**: ReactLynx `App.tsx` 한 벌, 플랫폼 분기 코드 없음.
2. **단일 백엔드 경로**: 모든 플랫폼이 `@rustra/lynx` rkyv V2 fast-path. `@rustra/tauri`(JSON IPC)는 데스크톱 capability 내부 구현용 옵션만.
3. **capability 추상**: rustra가 `trait Capability`(`FileCap`, `NotifyCap` 등) 정의. command 핸들러는 trait 메서드만 호출, 구현체는 플랫폼별(Desktop=Tauri 공식 plugin 감싸기, Mobile=Lynx NativeModule). 새 capability 추가 = trait 메서드 + 플랫폼 구현체, ReactLynx 영향 없음.
4. **Desktop 셸=Tauri, Mobile 셸=Lynx SDK**: Tauri는 윈도우·배포·capability 생태계, 모바일은 Lynx 자체 셸.

**재사용 runner**: 이 구조 전체를 runner 템플릿(Tauri desktop runner crate + Android/iOS 셸 스캐폴드 + rustra capability trait 세트)으로. 새 프로젝트는 runner 복사 → (a) rustra `#[command]`, (b) ReactLynx `App.tsx`, (c) 필요 capability만 켜기 → `tauri build` / APK / IPA.

## 5. 데스크톱 스파이크 명세 (가장 큰 리스크 디리스킹)

> 상세 구현 단계는 별도 impl plan `2026-08-11-tauri-lynx-desktop-spike.md` 에서.

### 목표

**Tauri desktop window 안에서 Lynx가 구동되는가?** 를 최소 코드로 증명/반증.

### 범위

- macOS 우선(로컬 SDK 확보). Tauri 2 desktop app + 단일 ReactLynx 뷰 + rustra `addNumbers` rkyv 왕복.
- 두 경로 순차 시도:
  - **경로 A(우선)**: Lynx 3.7/4.0 desktop C++ API가 host에 NSView 제공 → Tauri `raw-window-handle`(contentView) 삽입.
  - **경로 B(fallback)**: 현 `host.cpp` windowless RGBA renderer → Tauri window raw handle에 blit (`host_ui.mm` CALayer 패턴 이식).

### 성공 기준

1. Tauri desktop window 오픈.
2. window에 ReactLynx 뷰 렌더링(시각/RGBA 캡처).
3. ReactLynx → `addNumbers` → rkyv fast-path → UI 반영(현 host.cpp ack 패턴 재사용).
4. 경로 A 성공=안정 C++ API(ABI 핵 제거); 경로 B만 성공=windowless blit(ABI 부채 인정, 차기 A 재도전).

### 실패 시 fallback (정직)

두 경로 모두 Tauri window 안에서 불가 → Lynx 자체 NSWindow를 Tauri가 별도 자식 윈도우로 띄우는 구조로 후퇴. 단일 UI·백엔드는 유지, "한 윈도우" 포기. design 정정.

## 6. 미해결 리스크 (스파이크/차기 페이즈에서 해결)

1. ~~**Tauri↔Lynx surface 임베딩**: 스파이크 경로 A/B로 검증.~~ → **✅ 해소(2026-08-11 스파이크).** 경로 A(`LynxView::Builder::SetParent(NSView)`)로 Tauri window 안에 ReactLynx surface 임베딩 성공. 성공 기준 1(window 오픈)·2(뷰 렌더링) PASS. 결과: `docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md`.
2. ~~**host.cpp desktop C++ API 재작성**: Lynx desktop C++ API 형태(NSView vs windowless RGBA) 미확정 → 스파이크 1단계에서 가이드 확인.~~ → **✅ 해소.** SDK 4.0 `lynx_view_builder_set_parent(NativeWindow void*)` 정식 진입점 확인(Darwin: NSView\*). windowless RGBA renderer는 headless/offscreen 전용. 성공 기준 3(addNumbers rkyv 왕복 결과 42) PASS 로 host.cpp 의 N-API RustraModule + extension-module BTS 주입 패턴이 데스크톱에서도 그대로 동작함을 확인.
3. ~~**Windows libLynx 바이너리 입수**: 로컬은 macOS arm64만. Windows prebuilt 입수 경로(다운로드/빌드) 미확정 → macOS 스파이크 통과 후 확인.~~ → **✅ 해소(2026-08-12 Phase 4).** lynx-family/lynx GitHub 릴리스 4.0.1 에 `lynx_sdk_windows_x64.zip`(`lynx.dll` + `lynx.dll.lib`) 공개. CAPI 헤더가 macOS SDK 와 완전 동일 → 경로 A(`SetParent(NativeWindow=HWND)`) Windows 포팅 유효. Rust 백엔드 `cargo check --target x86_64-pc-windows-gnu` 클린. **잔존(Windows 머신 필요):** 호스트 C++ 빌드(MSVC)·런타임 검증, 그리고 FML 펌프 PE 심볼 해석(`GetProcAddress` 정식 해결 시도 → PE 오프셋 핵 fallback). macOS 의 Mach-O 오프셋(0x3ecc/0x43a4/0x9329bc) 과는 다른 경로. 결과: `docs/plans/2026-08-12-lynx-windows-phase4.md`.
4. ~~**capability NativeModule 모바일 구현**: 패턴은 있으나 capability별(File/Camera/Notify) Android/iOS NativeModule 신규 작성 필요.~~ → **부분 해소(2026-08-11 모바일 스파이크).** rkyv V2 왕복 NativeModule(`invokeRkyvV2` ByteArray ↔ Rust staticlib) 패턴이 iOS(Obj-C)·Android(Kotlin) 양쪽 모두 7/7 PASS 로 검증됨. 동일 9/52/95 바이트 응답(성공/typed-error/capability.denied)으로 와이어 포맷 플랫폼 중립 확정. **잔존:** capability별 command(read_file/notify/camera 등)의 플랫폼 구현체(`trait Capability` 구현)는 신규 작성 필요. 결과: `docs/plans/2026-08-11-lynx-mobile-spike-result.md`. 모바일 Lynx SDK 입수 리스크도 해소 — Android 는 `org.lynxsdk.lynx:lynx:4.0.1` 이 Maven Central 공개(plain `mavenCentral()`), iOS 는 CocoaPods source pod.
5. **Android ELF constructor 비대칭 (차기 runner 주의)**: Rust crate 의 `#[cfg(target_vendor="apple")] mod apple_init`(Mach-O `__mod_init_func`)가 라이브러리 로드 시 자동 패키지 등록하지만, Android(ELF) 에는 대응 constructor 가 없어 `JNI_OnLoad` 에서 `rustra_calculator_init()` 명시 호출이 필수. 생략 시 모든 rkyv 호출이 `ffi.not_registered`(out bytes=52) 로 떨어짐. runner 패키지화 시 Android 템플릿 기본값으로 문서화 필요.

## 7. 단계적 rollout (1차 성공 기준 → 범용 프레임워크)

- **Phase 1 — 데스크톱 스파이크**: macOS Tauri+Lynx 구동 증명(본 문서 §5). ✅ PASS (`2026-08-11-tauri-lynx-desktop-spike-result.md`).
- **Phase 2 — Android**: Lynx Android SDK 셸 + rustra rkyv NativeModule(Kotlin). 단일 ReactLynx 번들 재사용. ✅ PASS (`2026-08-11-lynx-mobile-spike-result.md`, verify-android.sh 7/7).
- **Phase 3 — iOS**: 동일하게 iOS(Obj-C). ✅ PASS (`2026-08-11-lynx-mobile-spike-result.md`, verify-ios.sh 7/7).
- **Phase 4 — Windows**: Windows libLynx 입수 + Phase 1 경로 포팅. ✅ 입수·분석 완료(`2026-08-12-lynx-windows-phase4.md`): SDK 공개 확보, CAPI 동일, Rust 크로스컴파일 증명, 포팅 3포인트 분석(SetParent HWND / 명시 init / FML PE 크럭스). 런타임 검증은 Windows 머신 필요(정직 연기).
- **Phase 5 — runner 패키지화**: 4플랫폼 통합 runner 템플릿 + capability trait 세트 → "실제 다른 프로젝트" 적용 가능 형태. ✅ 완료(2026-08-12, `2026-08-12-rustra-runner-template-design.md`): `runner/template/` 스캐폴드(app/backend/desktop/mobile-{ios,android}/capabilities), `backend/src/capabilities.rs`(FileCap/NotifyCap trait + CapabilityRegistry + DesktopRegistry std::fs, 단위테스트 3 PASS), `create-runner.sh`(복사+식별자 치환, 동작 검증), 각 플랫폼 `run.sh` 게이트. Rust 백엔드 `cargo check` clean. 플랫폼 셸 코드는 대응 스파이크에서 정제 추출(README 표로 포인터 명시).

각 Phase는 별도 impl plan으로 분리.
