# Tauri × Lynx Desktop Spike — Phase 0 결과 (경로 결정)

- **상태:** Phase 0 완료. **경로 A(SetParent NSView 삽입) 채택.**
- **날짜:** 2026-08-11
- **스파이크 plan:** `docs/plans/2026-08-11-tauri-lynx-desktop-spike.md` (Task 0.4)
- **design:** `docs/plans/2026-08-11-tauri-lynx-desktop-design.md`

> 본 문서는 Phase 0(Task 0.1~~0.4)의 결론을 기록한다. Phase 2~~4의 실행 결과는 본문 하단에 갱신한다.

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

### Phase 2 — Lynx surface 통합 (경로 A)

_(성공 기준 1/2 PASS/FAIL 기록)_

### Phase 3 — rustra rkyv 왕복

_(성공 기준 3 PASS/FAIL 기록)_

### Phase 4 — 최종

- 성공 기준 1: ☐
- 성공 기준 2: ☐
- 성공 기준 3: ☐
- 성공 기준 4: ☑ (본 문서)
