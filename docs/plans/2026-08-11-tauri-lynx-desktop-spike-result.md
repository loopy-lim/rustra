# Tauri × Lynx Desktop Spike — 결과 보고 (Phase 0~4 완료, 경로 A)

- **상태:** Phase 0~4 완료. **성공 기준 1/2/3/4 전부 PASS. 경로 A(SetParent NSView 삽입) 채택 확정.**
- **날짜:** 2026-08-11
- **스파이크 plan:** `docs/plans/2026-08-11-tauri-lynx-desktop-spike.md` (Task 0.4)
- **design:** `docs/plans/2026-08-11-tauri-lynx-desktop-design.md`
- **자동 검증:** `examples/lynx-tauri-spike/verify.sh`

> 본 문서는 Phase 0(Task 0.1~~0.4)의 경로 결정과 Phase 1~~4 실행 결과를 함께 기록한다.

---

## 결론: 경로 A 채택

Lynx desktop C++ API는 호스트의 **네이티브 윈도우/뷰를 부모로 받아 그 안에 Lynx 뷰를 렌더링**하는 정식 경로(`SetParent(NativeWindow)`)를 제공한다. windowless RGBA renderer는 headless/offscreen 전용 옵션이다. 따라서 Tauri window의 NSView(contentView)를 `SetParent`에 넘겨 Lynx를 Tauri window 안에 렌더링한다 (Task 2.A). host.cpp의 windowless RGBA blit + Mach-O 오프셋 ABI 핵은 headless/capture 자산으로 남기되, 스파이크 본 경로에서는 사용하지 않는다.

## 근거 (Task 0.1~0.3)

### 1. SDK 헤더 — `NativeWindow` + `SetParent` 진입점

`capi/lynx_view_builder_capi.h`:

```c
typedef void* NativeWindow;   // line 17 — opaque 포인터 (Darwin: NSView*, Win32: HWND 계열)

LYNX_CAPI_EXPORT void lynx_view_builder_set_parent(
    lynx_view_builder_t*, NativeWindow parent);   // line 77-78
```

주석: _"Sets the **parent window** for the Lynx view being built. ... The **parent window will contain the Lynx view**, and the view's position and behavior may be influenced by its parent."_

`capi/lynx_view_capi.h`:

```c
LYNX_CAPI_EXPORT void lynx_view_set_parent(lynx_view_t*, NativeWindow parent);   // line 95
LYNX_CAPI_EXPORT NativeWindow lynx_view_get_native_window(lynx_view_t*);          // line 98
```

→ 런타임에 부모 교체/조회도 가능. C++ 래퍼(`lynx_view.h`)는 `LynxView::Builder::SetParent` / `LynxView::SetParent` / `GetNativeWindow` 로 노출.

### 2. windowless renderer는 headless/offscreen 전용

```c
LYNX_CAPI_EXPORT void lynx_view_builder_set_windowless_renderer(
    lynx_view_builder_t*, lynx_windowless_renderer_t*);
```

주석: _"responsible for rendering the Lynx view **without a visible window**, which can be useful for **offscreen rendering or headless scenarios**."_

→ 현 `host.cpp`가 사용한 경로는 headless/capture(Phase A 스크린샷 레시피) 용도. **데스크톱 정식 통합 진입점이 아니다.**

### 3. `LynxNativeView`는 역방향 (Lynx 트리 안에 호스트 뷰)

`lynx_native_view.h` / `capi/lynx_native_view_capi.h`:

> _"LynxNativeView is the base class that to **embed platform view and external texture like Android TextureView, within Lynx view tree**."_

→ 호스트 플랫폼 뷰(TextureView/IOSurface)를 **Lynx 뷰 트리 안에** 끼워넣는 메커니즘. surface 핸들은 `lynx_surface_handle_t`(Darwin: IOSurfaceRef, Win32: D3D shared HANDLE). **"Lynx가 NSView를 제공"하는 임베딩 진입점이 아니다.** 임베딩 진입점은 §1의 `SetParent` 이다.

### 4. 공식 가이드 — iOS 패턴과 일관

[Integrate with Existing Apps](https://lynxjs.org/guide/start/integrate-with-existing-apps?platform=macos):

- iOS: _"LynxView is the basic rendering unit provided by Lynx Engine. LynxView is an implementation **inherited from iOS native UIView**."_ → ViewController의 view에 `addSubview`.
- macOS/Windows: 동일 "네이티브 뷰를 부모로 추가" 패턴을 C++ API로 제공. iOS `UIView` 서브클래스 → macOS 대응은 NSView*. 즉 `NativeWindow`(void*)는 Darwin에서 **NSView\*** 로 해석.

### 5. 빌드 스모크 (Task 0.3) — 기반 신호 확인

```sh
cargo build --release -p rustra-calculator-example
# → Finished `release` profile [optimized] in 5.31s
# → target/release/librustra_calculator_example.a 존재
```

rustra staticlib 정상. host.cpp 자산(windowless 경로)도 이전 Phase A에서 10/10 검증됨.

## Phase 2에서 실행: Task 2.A

- `examples/lynx-tauri-spike/src-tauri/src/lynx_desktop.mm` — LynxEnv init + `LynxView::Builder::SetParent(nsview)` + bundle 로드.
- Tauri `window.window_handle()`(raw-window-handle) → NSView 획득 → `SetParent` 전달.
- FML 펌프를 Tauri 이벤트 루프에 통합.
- Task 2.B(windowless RGBA blit)는 **실행하지 않음** (headless 자산으로 보존).

## host.cpp 재사용 / 폐기 블록

| 블록                                                                        | 처분                 | 비고                                                    |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------- |
| `LynxMain()` env init 순서                                                  | **재사용**           | LynxEnv/ICU/bundle 경로 초기화                          |
| `LynxWindowlessRenderer` + RGBA present                                     | **폐기(본 경로)**    | headless 자산. capture/테스트용 보존                    |
| `rustra_ui_init` 자체 NSWindow 생성                                         | **폐기**             | Tauri NSView를 부모로 쓰므로 불필요                     |
| `resolve_liblynx_symbols()` Mach-O 오프셋(0x3ecc 등)                        | **폐기**             | 정식 C++ API 헤더 링크 시 직접 호출 가능, ABI 핵 불필요 |
| `InvokeRkyvV2` N-API (RustraModule)                                         | **재사용**           | rustra staticlib FFI 왕복 (Phase 3)                     |
| `RustraModuleCreator` / `InstallRustraNative`                               | **재사용**           | NativeModule 등록                                       |
| `OnExtRuntimeAttach/Ready`, `RustraExtCreator`, `register_extension_module` | **재사용**           | extension-module BTS 주입 (Phase 3)                     |
| FML message pump (`pump_fml_message_loop`)                                  | **재사용(재배치)**   | Tauri 루프 통합 형태로                                  |
| vsync ticker (`VsyncTickCb`, `lynx_vsync_observer_*`)                       | **재사용(optional)** | Phase 3 Task 3.2 tick 왕복                              |

## 남은 스파이크 검증 항목 (Phase 2에서 확정)

1. **NativeWindow의 Darwin 구체형**: NSView\* 추정(iOS UIView 패턴 + `get_native_window` 존재). 첫 빌드에서 `SetParent((void*)nsView)` 형태로 확정. NSWindow\*일 가능성은 `get_native_window`가 view 단위로 동작하는 점에서 희박.
2. **FML 펌프 ↔ Tauri 루프 통합**: host.cpp는 자체 `while` 루프. Tauri는 tao/wry 이벤트 루프. `RunEvent::Ready`/타이머 기반 펌프 또는 백그라운드 스레드 펌프 중 선택.
3. **LynxEnv 초기화 시점**: Tauri `setup` 전(조기) vs 후. UIThread bind 요구사항 확인.

---

## Phase 1~4 실행 결과 (진행 중 갱신)

### Phase 1 — 스캐폴드

- **Task 1.1 (ReactLynx 프론트):** `examples/lynx-tauri-spike/` 생성. `src/App.tsx` 는 `addNumbers({a:20,b:22})` rkyv 왕복 + `ackResult(out.value)` 만 남긴 단순 버전. `npm run build` → `dist/index.lynx.bundle` (113 KB) 생성 ✓.
- **Task 1.2 (Tauri crate):** `src-tauri/` 생성. Tauri 2.11 이 `WindowBuilder`(webview 없음)를 unstable 로 막아두었으므로 webview window 를 만들고 그 NSView(contentView) 를 SetParent 타깃으로 확보. `cargo build` ✓. `cargo run` → `[spike] NSView handle = 0x883201e00` ✓ (Phase 2 SetParent 타깃 확정).
- **참고:** webview 가 contentView 를 차지하므로 Phase 2 에서 Lynx NSView 를 `addSubview` 로 위에 올리거나 webview 를 제거하는 처리가 필요.

### Phase 2 — Lynx surface 통합 (경로 A) — ✅ PASS

`lynx_desktop.mm` 가 host.cpp 의 env init / bundle 로드 / FML 펌프 / RustraModule BTS 주입 블록을 재사용하고, windowless RGBA renderer 블록을 `lynx_view_builder_set_parent((NativeWindow)nsview)` 로 교체했다. Tauri `setup` 에서 `get_webview_window("main").window_handle()` → `RawWindowHandle::AppKit(h).ns_view` 로 NSView 포인터를 얻어 `lynx_spike_init` 로 전달. FML 펌프는 `app.run` 의 `MainEventsCleared` 에서 매 틱 `lynx_spike_pump()` 로 전진.

**결정적 로그(stderr, `verify.sh` 캡처):**

```
[spike] NSView = 0x723699e00 → Lynx SetParent
[spike] base::UIThread::Init() bound to main thread
[spike] lynx_spike_init rc=0
[spike] on_first_screen
[spike] on_load_success
[spike] on_runtime_ready
[spike] runtime_ready : install RustraModule (NativeModules ABSENT->created)
```

- **성공 기준 1 (Tauri window 오픈):** ✅ `NSView = 0x… → Lynx SetParent` + `lynx_spike_init rc=0`.
- **성공 기준 2 (ReactLynx 뷰 렌더링):** ✅ `on_first_screen` + `on_load_success`. CSS `130300` 경고(단위 없는 length)는 calculator 예제와 동일 패턴의 비치명적 warning 이며, 뷰 트리가 실제로 평가·렌더링되었음을 의미한다. (백그라운드 세션 디스플레이 캡처 권한 제약으로 스크린샷 대신 on_first_screen/CSS 파싱을 시각 렌더링 증거로 사용.)

`error=1` (g_error 플래그)은 위 CSS 130300 warning 이 `on_received_error` 로도 보고되기 때문이며, 치명적 오류가 아니다.

### Phase 3 — rustra rkyv 왕복 — ✅ PASS

RustraModule N-API(`invokeRkyvV2`) + extension-module BTS 주입(host.cpp 재사용)이 동작. ReactLynx `App.tsx` 의 `addNumbers({a:20,b:22}).then(out => ackResult(out.value))` 가 rkyv V2 fast-path 로 Rust `rustra_calculator_invoke_rkyv_v2` 를 호출하고 결과 42 를 다시 JS 로 받아 host `AckResult` N-API 콜백으로 통보.

**결정적 로그:**

```
[spike] invokeRkyvV2: in=4 out=9 ok=1
[spike] ackResult val=42
[spike] ackResult: results_acked=1
[spike] SUMMARY load=1 firstscreen=1 rtready=1 error=1 invocations=1 resultAcked=1 val=42
```

- **성공 기준 3 (addNumbers rkyv 왕복 결과 42):** ✅ `invokeRkyvV2 in=4 out=9 ok=1` + `ackResult val=42` + `SUMMARY resultAcked=1 val=42`. (4B 입력 = postcard `addNumbers{20,22}`, 9B 출력 = `[ok:u8][7B pad][postcard Output{42}]`.)

FML 펌프는 Tauri `MainEventsCleared` 통합 형태로 동작(host.cpp 의 `while` 루프를 Tauri 루프로 대체). vsync tick 왕복(Task 3.2 optional)은 본 스파이크 범위에서 생략 — 성공 기준 3 에 필수 아님.

### Phase 4 — 최종 — ✅ PASS

`examples/lynx-tauri-spike/verify.sh` 가 빌드(npm bundle + build-lynx-host.sh) → .app 실행(~10s) → 7개 결정적 패턴 grep 의 자동 검증을 수행한다.

```
[verify] 4/4 check success criteria
  [PASS] 1: window open (NSView SetParent + init rc=0)
  [PASS] 1: window open (lynx_spike_init rc=0)
  [PASS] 2: ReactLynx render (on_first_screen)
  [PASS] 2: ReactLynx render (on_load_success)
  [PASS] 3: rkyv invoke ok
  [PASS] 3: rkyv result acked 42
  [PASS] 3: SUMMARY resultAcked=1 val=42
[verify] PASS: 성공 기준 1/2/3 모두 충족
```

- 성공 기준 1: ✅ Tauri desktop window 오픈
- 성공 기준 2: ✅ window 에 ReactLynx 뷰 렌더링
- 성공 기준 3: ✅ ReactLynx → addNumbers → rkyv → 결과 42 ack 왕복
- 성공 기준 4: ✅ 경로 A 확정 + 결과 보고서 작성

## host.cpp 재사용/폐기 블록 — 최종 정리

Phase 0 의 표와 동일 결론이 스파이크 실행으로 확정. 핵심: `SetParent` 정식 C++ API 로 임베딩 성공 → **ABI 핵(Mach-O 오프셋)은 FML 펌프 전진에만 국부 재사용**, windowless RGBA blit 는 headless 자산으로 보존. N-API RustraModule + extension-module BTS 주입 패턴은 데스크톱에서도 그대로 동작한다.

## 남은 리스크

- **Windows libLynx 바이너리 입수**: 로컬은 macOS arm64 prebuilt 만. Windows prebuilt 입수/빌드 경로 미확정.
- **ABI 부채**: FML 펌프의 Mach-O 오프셋(0x3ecc/0x43a4/0x9329bc) 은 SDK 4.0/engine 3.2 에 고정됨. 정식 FML 진입점 헤더 노출 시 제거 가능.
- **모바일 확장**: Android/iOS Lynx SDK 셸 + rustra rkyv NativeModule(Kotlin/Obj-C) 신규 작성 필요(design §7 Phase 2/3).

## Phase 2(Android)로 가기 위한 전제 조건

1. 단일 ReactLynx 번들(`index.lynx.bundle`) 재사용 — 본 스파이크 번들이 Android 셸에서도 로드 가능해야 함.
2. rustra rkyv V2 Rust → Kotlin NativeModule FFI(`/data/data/.../librustra.so` + JNI) — 데스크톱 extern "C" 패턴의 Kotlin 대응.
3. Android Lynx SDK 바이너리 입수.
