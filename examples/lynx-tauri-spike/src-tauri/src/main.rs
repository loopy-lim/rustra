// Phase 2: Tauri window 의 NSView(contentView) 를 LynxView::Builder::SetParent 로 넘겨
// Lynx 가 Tauri window 안에 렌더링하게 한다(경로 A). lynx_desktop.mm 의 extern "C" 인터페이스:
//   lynx_spike_init(nsview, bundle, icu) — setup 단계, 메인 스레드 1회
//   lynx_spike_pump()                    — MainEventsCleared 마다 호출 (FML 메시지 루프 전진)
//   lynx_spike_summary()                 — 검증용 카운터 stderr 출력
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::ffi::{c_char, c_int, c_void, CString};
use std::process::exit;
use tauri::{Manager, RunEvent};

extern "C" {
    fn lynx_spike_init(
        parent_nsview: *mut c_void,
        bundle_path: *const c_char,
        icu_path: *const c_char,
    ) -> c_int;
    fn lynx_spike_pump();
    fn lynx_spike_summary() -> c_int;
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
            let nsview: *mut c_void = match handle.as_raw() {
                RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as *mut c_void,
                other => {
                    eprintln!(
                        "[spike] non-AppKit raw handle: {:?} — Lynx SetParent 불가",
                        other
                    );
                    panic!("AppKit NSView required");
                }
            };
            eprintln!("[spike] NSView = {:?} → Lynx SetParent", nsview);

            let bundle = std::env::var("LYNX_BUNDLE").unwrap_or_else(|_| {
                // 기본: spike 예 dist/index.lynx.bundle
                let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
                format!("{}/../dist/index.lynx.bundle", manifest_dir)
            });
            let bundle_c = CString::new(bundle).expect("bundle path nul");
            let icu_c = env_path("LYNX_ICU", "data/icudtl.dat");

            let rc = unsafe { lynx_spike_init(nsview, bundle_c.as_ptr(), icu_c.as_ptr()) };
            eprintln!("[spike] lynx_spike_init rc={}", rc);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri spike app");

    app.run(|_app_handle, event| {
        if let RunEvent::MainEventsCleared = event {
            // Lynx BTS/runtime 메시지 루프 전진. host.cpp 의 while-pump 를 Tauri 루프로 대체.
            unsafe { lynx_spike_pump() };
        }
        if let RunEvent::ExitRequested { .. } = event {
            unsafe { lynx_spike_summary() };
        }
    });

    // SIGTERM 등으로 즉시 빠져나온 경우도 요약 출력.
    let _ = unsafe { lynx_spike_summary() };
    let acked = unsafe { lynx_spike_summary() };
    if acked <= 0 {
        eprintln!("[spike] rkyv 왕복 미확인 (resultAcked=0) — exit 3");
        exit(3);
    }
}
