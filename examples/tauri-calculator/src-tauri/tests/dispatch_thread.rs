//! A command may block, including an async rustra handler's synchronous executor.
//! Registration must keep that work off the WebView's IPC dispatch thread.
use rustra::{Package, RustraError, tauri_support};
use serde_json::{Value, json};
use tauri::WebviewWindowBuilder;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

fn request(command: &str, args: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.into(),
    }
}

#[test]
fn single_batch_and_profiled_commands_do_not_run_on_the_ipc_thread() {
    let ipc_thread = std::thread::current().id();
    let package = Package::builder("thread.probe")
        .command("probe", move |_: Value| {
            Ok::<_, RustraError>(json!({"onIpcThread": std::thread::current().id() == ipc_thread}))
        })
        .build();
    let app = tauri_support::register_profiled(package, mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "thread-probe", Default::default())
        .build()
        .unwrap();
    for command in [
        "rustra_dispatch",
        "rustra_dispatch_batch",
        "rustra_dispatch_profiled",
    ] {
        let args = if command == "rustra_dispatch_batch" {
            json!({"requests": [{"command": "probe", "args": {}}]})
        } else {
            json!({"command": "probe", "args": {}})
        };
        let body = get_ipc_response(&webview, request(command, args)).unwrap();
        let response: Value = body.deserialize().unwrap();
        let value = match command {
            "rustra_dispatch_batch" => &response[0]["result"],
            "rustra_dispatch_profiled" => &response["result"],
            _ => &response,
        };
        assert_eq!(
            value["onIpcThread"],
            json!(false),
            "{command} blocks the IPC thread"
        );
    }
}
