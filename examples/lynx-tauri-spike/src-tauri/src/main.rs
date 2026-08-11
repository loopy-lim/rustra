// Phase 1: Tauri desktop window 를 띄우고 raw-window-handle(NSView) 을 로깅한다.
// Lynx surface 결합은 Phase 2(SetParent NSView) 에서.
//
// 참고: Tauri 2.11 은 webview-없는 순수 window(WindowBuilder) 를 unstable 로 막아두었기
// 때문에, webview window 를 만들고 그 window 의 NSView(contentView) 를 얻는다. Phase 2
// 에서 이 NSView 에 LynxView 를 SetParent/addSubview 하면 webview 위에 Lynx 가 렌더링된다.
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");
            let handle = window.window_handle()?;
            match handle.as_raw() {
                RawWindowHandle::AppKit(h) => {
                    // NSView 포인터. Phase 2 에서 LynxView::Builder::SetParent 로 넘긴다.
                    println!(
                        "[spike] NSView handle = {:?} (Phase 2 SetParent 타깃)",
                        h.ns_view
                    );
                }
                other => {
                    println!("[spike] non-AppKit raw handle: {:?}", other);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri spike app");
}
