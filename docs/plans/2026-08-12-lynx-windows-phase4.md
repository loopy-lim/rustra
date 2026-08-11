# Lynx Windows (Phase 4) — 조사 결과 + 포팅 분석

- **상태:** Phase 4 조사 완료. **design §6 리스크 3(Windows libLynx 입수) 해소.** 런타임 검증은 Windows 머신 필요(정직).
- **날짜:** 2026-08-12
- **design:** `docs/plans/2026-08-11-tauri-lynx-desktop-design.md` §6 리스크 3 / §7 Phase 4
- **선행 스파이크:** `docs/plans/2026-08-11-tauri-lynx-desktop-spike-result.md`(macOS 경로 A)

---

## 결론: Windows libLynx 바이너리는 공개 배포됨 — Phase 4 입수 리스크 해소

lynx-family/lynx GitHub 릴리스 4.0.1 에 **`lynx_sdk_windows_x64.zip`** (및 x86) 가 공개되어 있다.
macOS `lynx_sdk_macos_arm64.zip` 의 Windows 대응물이며, **CAPI 헤더가 macOS SDK 와 완전 동일**하다.
즉 데스크톱 스파이크가 증명한 경로 A(`LynxView::Builder::SetParent(NativeWindow)`)가 Windows 에서도
동일한 CAPI 로 동작한다. `NativeWindow void*` 는 Darwin=NSView\* / Win32=HWND.

### Windows SDK 내용 (`lynx_sdk_windows_x64.zip`, 68 files / 22 MB)

```
lib/lynx.dll           19,212,288   ← 런타임 (macOS libLynx.dylib 대응)
lib/lynx.dll.lib          329,160   ← MSVC import library
data/icudtl.dat            778,864   ← ICU 데이터 (macOS 와 동일)
include/...                          ← CAPI 헤더 (macOS 와 동일: lynx_view_builder_capi.h 등)
```

CAPI 진입점 동일 확인 (Windows 헤더 grep):

```c
// include/capi/lynx_view_builder_capi.h:17,77-78
typedef void* NativeWindow;
LYNX_CAPI_EXPORT void lynx_view_builder_set_parent(lynx_view_builder_t*, NativeWindow parent);
// include/capi/lynx_view_capi.h:95,98
LYNX_CAPI_EXPORT void lynx_view_set_parent(lynx_view_t*, NativeWindow parent);
LYNX_CAPI_EXPORT NativeWindow lynx_view_get_native_window(lynx_view_t*);
```

### Rust 백엔드 Windows 포터빌리티 증명

```
$ rustup target add x86_64-pc-windows-gnu
$ cargo check -p rustra-calculator-example --target x86_64-pc-windows-gnu
   ...
   Checking rustra-calculator-example v0.1.0
   Finished `dev` profile [unoptimized + debuginfo] target(s) in 7.88s
```

단일 rustra Rust 백엔드가 Windows 타깃으로 타입체크 클린. 링크(mingw-w64 / MSVC)는 Windows 머신 필요.

---

## Windows 포팅 — 3개 포인트

macOS 데스크톱 스파이크 호스트(`examples/lynx-tauri-spike/src-tauri/src/lynx_desktop.mm`)의 ~90%는
CAPI 기반이라 Windows 에서 그대로 동작한다. 플랫폼 의존부는 3곳:

### 포인트 1 — SetParent 타깃: NSView → HWND (쉬움, ✅ 코드 추가 완료)

Tauri `raw-window-handle` 에 Windows arm 추가. NSView 와 동일한 `void*` 로 `lynx_spike_init` 에 전달.

```rust
// examples/lynx-tauri-spike/src-tauri/src/main.rs
let parent: *mut c_void = match handle.as_raw() {
    RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as *mut c_void,   // macOS
    RawWindowHandle::Win32(h) => h.hwnd.get() as *mut c_void,          // Windows ✅ 추가
    other => { /* ... */ }
};
```

### 포인트 2 — Rust 패키지 명시 init (쉬움, ✅ 코드 추가 완료)

Apple 은 Mach-O `__mod_init_func` constructor 가 라이브러리 로드 시 자동으로 `calculator_package()` 를
FFI 레지스트리에 등록한다(`examples/calculator/src/lib.rs:519` `#[cfg(target_vendor="apple")]`).
**Windows(PE) 에는 이 constructor 가 없다** (Android ELF 과 동일한 갭 — 모바일 스파이크에서
`JNI_OnLoad`→`rustra_calculator_init()` 로 해결한 것과 동일). 따라서 Windows 호스트도 로드 시
명시 호출해야 한다. macOS 호스트에도 idempotent 호출을 추가해 Apple 자동등록에 의존하지 않게 했다
(양쪽 동일 코드 경로).

```cpp
// examples/lynx-tauri-spike/src-tauri/src/lynx_desktop.mm — lynx_spike_init 선두
extern "C" void rustra_calculator_init(void);   // idempotent (OnceLock)
...
rustra_calculator_init();   // Windows/ELF: 필수. Apple: no-op 에 가깝지만 harmless.
```

### 포인트 3 — FML 메시지 루프 펌프 심볼 해석 (⚠️ 크럭스, 미해결)

이것이 Windows 포팅의 진짜 장벽이다. Lynx BTS/runtime 작업(rkyv 왕복 포함)을 전진시키려면
`fml::MessageLoop::RunExpired` 류의 펌프가 매 틱 호출되어야 한다. 그런데 **이 심볼들은 SDK 헤더에
공식 노출되지 않는다** (Windows 헤더 grep: FML/MessageLoop/UIThread 공식 심볼 없음 — 오직
`lynx_windowless_renderer_capi.h` 만 hit). macOS 스파이크는 이를 **Mach-O image base + 하드코딩 오프셋**
으로 해결했다(ABI 부채):

```cpp
// lynx_desktop.mm resolve_liblynx_symbols() — Mach-O 전용 (Windows 에선 동작 안 함)
#include <mach-o/dyld.h>
for (i ...) { if (strstr(name, "libLynx")) {
    g_fml_is_init     = at(0x3ecc);     // FmlIsInit
    g_fml_run_expired = at(0x43a4);     // FmlRunExpired
    g_ui_thread_init  = at(0x9329bc);   // UIThreadInit
}}
```

Windows(PE) 에선: (a) `_dyld_image_count`/`_dyld_get_image_header` 대신 `GetModuleHandleW(L"lynx")`
사용, (b) 오프셋은 **완전히 다름** (PE layout ≠ Mach-O), (c) PE 가 심볼을 export 테이블로 노출하면
`GetProcAddress` 로 정식 해결 가능(가능하다면 오프셋 핵 제거 = ABI 부채 상환).

**Windows FML 펌프 해결 옵션 (우선순위):**

1. **`GetProcAddress` 정식 해결 시도** (최선) — `lynx.dll` 이 FML/UIThread 심볼을 export 하면
   `GetProcAddress(GetModuleHandleW("lynx"), "?RunExpired@MessageLoop@fml@@...")` 로 오프셋 없이 해결.
   Windows 머신에서 `dumpbin /exports lynx.dll` 또는 `link /dump` 로 export 테이블 확인 필요.
2. **PE 오프셋 핵** (fallback, ABI 부채 증폭) — PE `IMAGE_DOS_HEADER`→`IMAGE_NT_HEADERS`→
   section 을 파싱해 Mach-O 과 동등한 image-base+offset 계산. 오프셋은 SDK 4.0 Windows 빌드에
   고정. macOS 0x3ecc/0x43a4/0x9329bc 와는 다른 값.
3. **windowless renderer 경로** (후퇴) — macOS host.cpp 의 headless 자산(`lynx_windowless_renderer`)
   은 Windows 헤더에도 존재. SetParent 경로가 안 되면 windowless RGBA → HWND blit 로 후퇴.
   단 이 경로는 BTS 펌프가 여전히 필요할 수 있음.

옵션 1 이 통하면 macOS 의 ABI 부채(Mach-O 오프셋)까지 같이 상환할 수 있어 가장 가치있다.
**이 검증은 Windows 머신에서만 가능**하다(macOS 에선 `lynx.dll` export 테이블을 링커 관점에서
확인할 수 없고, PE 오프셋을 런타임 검증할 수 없음).

---

## 크로스플랫폼 회귀 발견·수정 (Phase 4 작업 중)

Windows 포팅 준비로 데스크톱 호스트를 만지는 중 `verify.sh` 가 ackResult 실패를 잡았다.
추적 결과 **모바일 스파이크(Phase A/B)가 바꾼 `getRustraNative()` 우선순위가 데스크톱 ackResult
경로를 망가뜨린 회귀**였다. 단위 테스트는 이 런타임 경로를 거치지 않아 놓쳤다.

- **원인:** 모바일 작업이 `getRustraNative()` 를 closure `NativeModules` 우선으로 바꿨다.
  데스크톱에선 Lynx NAPI 가 closure `NativeModules.RustraModule` 을 native-module 프록시
  (method map 에 `invokeRkyvV2` 만 있음)로 채워, 호스트가 `globalThis` 에 주입한
  `ackResult` 포함 객체를 가렸다.
- **수정:** 우선순위를 **globalThis 우선 → closure 폴백**으로 뒤집었다.
  - 데스크톱: `globalThis.NativeModules.RustraModule`(호스트 주입, full surface) 복원.
  - 모바일: globalThis 비어있음 → closure 폴백 (기존과 동일).
  - Node 테스트: globalThis.NativeModules 주입 → 동일 동작.
- **재검증:** 단위 24/24 + 32/32, 데스크톱 verify 7/7, iOS 7/7, Android 7/7 전부 PASS 복원/유지.

이것이 "문제점 모두 확인" 의 첫 결실 — 공유 코드(`getRustraNative`) 변경이 3플랫폼에 미치는
영향을 런타임 게이트로 잡아냈다.

---

## 런타임 검증 상태 (정직)

| 항목               | macOS                               | Windows                                     |
| ------------------ | ----------------------------------- | ------------------------------------------- |
| SDK 입수           | ✅ 로컬 `/tmp/lynx-prebuilt/macsdk` | ✅ GitHub 릴리스 다운로드                   |
| CAPI 동일성        | ✅                                  | ✅ (헤더 diff 없음)                         |
| Rust 백엔드 포터빌 | ✅ 빌드                             | ✅ `cargo check x86_64-pc-windows-gnu` 클린 |
| 호스트 C++ 빌드    | ✅ (clang)                          | ❌ MSVC 필요 (macOS 에서 불가)              |
| 런타임 rkyv 왕복   | ✅ 7/7 verify.sh                    | ❌ Windows 머신 필요                        |
| FML 펌프           | ✅ Mach-O 오프셋                    | ❓ PE 해석 미확정(옵션 1/2/3)               |

Windows 런타임 검증은 본 머신(macOS)의 한계로 불가. `verify-windows.ps1`(별도) 을 Windows 머신에서
실행해야 완료된다. Phase 4 는 **입수 리스크 해소 + 포팅 분석 완료 + 크로스플랫폼 회귀 수정**까지를
성과로 하고, Windows 런타임 증명은 별도 Windows 환경으로 연기한다(정직 보고).

## design 반영

- §6 리스크 3 "Windows libLynx 바이너리 입수": ✅ **해소** — `lynx_sdk_windows_x64.zip` 공개.
- §7 Phase 4: 입수 + 분석 완료. 런타임은 Windows 환경 의존. FML PE 해석(옵션 1 우선)이 남은 기술 검증.
