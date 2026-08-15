# Windows 포팅 가이드 (desktop 템플릿)

> **상태:** 스캐폴드 구현 완료(2026-08-15) — `src-tauri/src/lynx_desktop_win.cpp` +
> `build.rs` Windows 분기 실재. 남은 것: Windows 머신에서 dumpbin 으로 FML 심볼
> export/오프셋 확정 + 컴파일·런타임 검증 (정직 연기).
> 근거 조사: `docs/plans/2026-08-12-lynx-windows-phase4.md` · 문제점: P1/P8
> (`docs/plans/2026-08-12-cross-platform-problems-review.md`).

macOS 셸(`src-tauri/src/lynx_desktop.mm`)의 Windows 포팅 3포인트와 검증 절차.
`main.rs` 는 Win32 HWND 분기 포함(수정 불필요), `lynx_desktop_win.cpp` 는
macOS 버전의 전체 구조(N-API 모듈·extension module·fetcher·init/pump/summary)를
그대로 옮긴 스캐폴드다.

## 1. 전제 (Windows 머신)

1. Visual Studio Build Tools (MSVC) + Windows SDK.
2. Lynx Windows SDK:
   ```powershell
   gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_windows_x64.zip
   # 해제 후 → LYNX_SDK_WIN 환경변수 = 해제 디렉토리 (lynx.dll / lynx.dll.lib / include / data)
   ```
   CAPI 헤더가 macOS SDK 와 완전 동일함을 확인했으므로(Phase 4 조사) `lynx_desktop.mm` 의
   `#include "capi/..."` 전부 그대로 유효하다.
3. `rustup target add x86_64-pc-windows-msvc`

## 2. 포팅 3포인트

### 포인트 1 — SetParent HWND (쉬움)

`main.rs` 의 `RawWindowHandle::Win32(h) => h.hwnd.get() as *mut c_void` 분기가 이미 있다.
`lynx_view_builder_set_parent(builder, (NativeWindow)parent)` 은 `void*` 를 받으므로
Windows 에서 HWND 가 그대로 전달된다. 변경 불필요.

### 포인트 2 — 명시 rustra init (쉬움, 필수)

Windows(PE) 에는 Apple 의 `__mod_init_func` 자동 등록이 없다.
`lynx_template_init()` 시작부의 `rustra_template_init()` 명시 호출(이미 포함)이 필수.
누락 시 모든 rkyv 호출이 `ffi.not_registered` 로 떨어진다.

### 포인트 3 — FML 메시지 루프 펌프 심볼 해석 (★ 크럭스)

macOS 는 Mach-O image-base + 하드코딩 오프셋(0x3ecc=IsInit, 0x43a4=RunExpired,
0x9329bc=UIThreadInit)으로 `fml::MessageLoop` 심볼을 해석한다. Windows(PE) 등가:

1. **GetProcAddress 정식 해결 (1차 시도)** — `GetModuleHandleW(L"lynx.dll")` 후
   `GetProcAddress(h, "_ZN3fml11MessageLoop...")` 형태 mangled name 조회.
   심볼이 export 되어 있으면 가장 깨끗하다 (확률 낮음: BTS 내부 심볼).
2. **PE 오프셋 하드코딩 (2차, macOS 와 동일 기법)** — `dumpbin /exports lynx.dll`
   또는 `objdump -p lynx.dll` 로 image base 를 구하고, 디스어셈블리에서
   IsInit/RunExpired/UIThreadInit 오프셋 추출. macOS 절차와 동일한 ABI 핀.
3. **windowless fallback (3차, 불확실)** — 펌프 없이 동작하는 경로 탐색.

```cpp
// lynx_desktop_win.cpp resolve_liblynx_symbols() 에 이미 구현된 구조:
//   1차 — GetProcAddress 정식 export 조회
//         (kFmlIsInitExportName 등이 nullptr = 아직 미확정)
//   2차 — PE image base + 오프셋
//         (kFmlIsInitOffset 등이 0 = 아직 미확정)
// Windows 머신에서 dumpbin /exports lynx.dll 결과로 확정한다:
//   - export 존재 → kFml*ExportName 에 mangled name 기입 (ABI 부채 없음, 최선)
//   - 미export   → 오프셋 추출 후 kFml*Offset 기입 (macOS 와 동일 ABI 핀)
```

`build.rs` 는 `CARGO_CFG_TARGET_OS` 로 분기해 `lynx_desktop.mm`(Darwin) /
`lynx_desktop_win.cpp`(Windows) 를 대상별 컴파일한다 (구현 완료).

## 3. 빌드 절차 (Windows 머신)

```powershell
# Rust backend staticlib (MSVC)
cargo build --release --manifest-path backend\Cargo.toml --target x86_64-pc-windows-msvc

# Tauri 호스트 (.exe) — build.rs 가 lynx_desktop_win.cpp + lynx.dll.lib 링크
cargo build --release --manifest-path desktop\src-tauri\Cargo.toml

# lynx.dll 을 .exe 옆에 복사 (로드 경로)
Copy-Item "$env:LYNX_SDK_WIN\lib\lynx.dll" desktop\src-tauri\target\release\

# 실행
$env:LYNX_BUNDLE = "app\dist\index.lynx.bundle"
$env:LYNX_SDK    = $env:LYNX_SDK_WIN
$env:LYNX_ICU    = "$env:LYNX_SDK_WIN\data\icudtl.dat"
desktop\src-tauri\target\release\rustra-template-desktop.exe
```

`build.rs` Windows 분기: `cc` 로 `lynx_desktop_win.cpp` 컴파일 후
`cargo:rustc-link-search=native=$LYNX_SDK_WIN\lib` + `cargo:rustc-link-lib=dylib=lynx`
(.dll.lib import lib). rustra backend staticlib 은 macOS 와 동일하게 직접 링크.

## 4. 검증

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File verify-windows.ps1
```

게이트 6패턴(native handle SetParent / init rc=0 / on_first_screen /
on_load_success / invokeRkyvV2 ok=1 / SUMMARY resultAcked>=1).

## 5. 알려진 제약

- FML PE 오프셋은 SDK 4.0.1 x64 바이너리에 ABI-핀된다. SDK 업데이트 시 재추출.
- ICU 데이터 파일(`icudtl.dat`)이 Windows SDK 에 포함되어 있는지 설치 시 확인
  (macOS SDK 와 레이아웃 동일 확인됨).
- Rust backend 크로스컴파일 검증: `cargo check --target x86_64-pc-windows-gnu` clean
  (Phase 4, 본 머신). MSVC 실빌드는 Windows 머신 필요.
