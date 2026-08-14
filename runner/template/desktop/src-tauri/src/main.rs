// rustra runner 템플릿 — Tauri 데스크톱 셸 (macOS now / Windows 포팅 WINDOWS.md).
// examples/lynx-tauri-spike/src-tauri/src/main.rs 에서 정제 추출.
//
// Tauri window 의 native handle(NSView/HWND) 을 LynxView::Builder::SetParent 로
// 넘겨 Lynx 가 Tauri window 안에 렌더링하게 한다(경로 A). lynx_desktop.mm 인터페이스:
//   lynx_template_init(native_window, bundle, icu) — setup 단계, 메인 스레드 1회
//   lynx_template_pump()                      — MainEventsCleared 마다 호출 (FML 전진)
//   lynx_template_summary()                   — 검증용 카운터 stderr 출력
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::ffi::{c_char, c_int, c_void, CString};
use std::process::exit;
use tauri::{Manager, RunEvent};

extern "C" {
    fn lynx_template_init(
        parent_native_window: *mut c_void,
        bundle_path: *const c_char,
        icu_path: *const c_char,
    ) -> c_int;
    fn lynx_template_pump();
    fn lynx_template_summary() -> c_int;
}

fn env_path(var: &str, default_suffix: &str) -> CString {
    let sdk = std::env::var("LYNX_SDK").unwrap_or_else(|_| "/tmp/lynx-prebuilt/macsdk".into());
    let p = std::env::var(var).unwrap_or_else(|_| format!("{}/{}", sdk, default_suffix));
    CString::new(p).expect("path nul")
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");
            let handle = window.window_handle()?;
            // Lynx SetParent 의 NativeWindow(void*)는 Darwin=NSView*, Windows=HWND.
            let parent: *mut c_void = match handle.as_raw() {
                // ns_view.as_ptr() 는 이미 *mut c_void (raw-window-handle 0.6 AppKit).
                RawWindowHandle::AppKit(h) => h.ns_view.as_ptr(),
                // hwnd: NonZeroIsize → isize → *mut c_void (HWND).
                RawWindowHandle::Win32(h) => h.hwnd.get() as *mut c_void,
                other => {
                    eprintln!(
                        "[template] unsupported raw handle: {:?} — Lynx SetParent 불가",
                        other
                    );
                    panic!("AppKit NSView or Win32 HWND required");
                }
            };
            eprintln!(
                "[template] native window handle = {:?} → Lynx SetParent",
                parent
            );

            let bundle = std::env::var("LYNX_BUNDLE").unwrap_or_else(|_| {
                // 기본: 템플릿 app 예 dist/index.lynx.bundle
                let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
                format!("{}/../../../app/dist/index.lynx.bundle", manifest_dir)
            });
            let bundle_c = CString::new(bundle).expect("bundle path nul");
            let icu_c = env_path("LYNX_ICU", "data/icudtl.dat");

            let rc = unsafe { lynx_template_init(parent, bundle_c.as_ptr(), icu_c.as_ptr()) };
            eprintln!("[template] lynx_template_init rc={}", rc);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building rustra template desktop app");

    app.run(|_app_handle, event| {
        if let RunEvent::MainEventsCleared = event {
            // Lynx BTS/runtime 메시지 루프 전진. Tauri 루프에 펌프를 통합.
            unsafe { lynx_template_pump() };
        }
        if let RunEvent::ExitRequested { .. } = event {
            unsafe { lynx_template_summary() };
        }
    });

    // SIGTERM 등으로 즉시 빠져나온 경우도 요약 출력.
    let _ = unsafe { lynx_template_summary() };
    let acked = unsafe { lynx_template_summary() };
    if acked <= 0 {
        eprintln!("[template] rkyv 왕복 미확인 (resultAcked=0) — exit 3");
        exit(3);
    }
}
