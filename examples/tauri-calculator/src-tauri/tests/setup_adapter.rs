use rustra::hot_core::JsonDispatch;
use rustra::{Package, RustraError};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{Listener, State, WebviewWindowBuilder};

#[path = "fixtures/setup_registration.rs"]
mod rustra_setup;

static TEST_LOCK: Mutex<()> = Mutex::new(());

pub fn package() -> Package {
    static PACKAGE: OnceLock<Package> = OnceLock::new();
    PACKAGE
        .get_or_init(|| {
            Package::builder("app.setup")
                .command("echo", |args: Value| Ok::<_, RustraError>(args))
                .build()
        })
        .clone()
}

#[tauri::command]
fn app_greet(state: State<'_, String>) -> String {
    state.inner().clone()
}

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
fn generated_registration_executes_first_echo_and_verifies_contract() {
    let _guard = TEST_LOCK.lock().unwrap();
    let app = rustra_setup::register(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "setup-echo", Default::default())
        .build()
        .unwrap();
    let echo = get_ipc_response(
        &webview,
        request(
            "rustra_dispatch",
            json!({"command":"echo","args":{"message":"hello from setup"}}),
        ),
    )
    .unwrap();
    assert_eq!(
        echo.deserialize::<Value>().unwrap(),
        json!({"message":"hello from setup"})
    );
    let hash = get_ipc_response(&webview, request("rustra_contract_hash", json!({}))).unwrap();
    assert_eq!(
        hash.deserialize::<String>().unwrap(),
        package().contract_hash().unwrap()
    );
}

#[test]
fn generated_app_handler_composition_preserves_state_events_and_plugins() {
    let _guard = TEST_LOCK.lock().unwrap();
    let plugin_started = Arc::new(Mutex::new(false));
    let started = plugin_started.clone();
    let plugin = tauri::plugin::Builder::<_, ()>::new("setup-existing")
        .setup(move |_, _| {
            *started.lock().unwrap() = true;
            Ok(())
        })
        .build();
    let app = rustra_setup::with_app_commands(
        mock_builder()
            .manage("app command still works".to_string())
            .plugin(plugin),
        tauri::generate_handler![app_greet],
    )
    .build(mock_context(noop_assets()))
    .unwrap();
    assert!(*plugin_started.lock().unwrap());
    let webview = WebviewWindowBuilder::new(&app, "setup-app", Default::default())
        .build()
        .unwrap();
    let greet = get_ipc_response(&webview, request("app_greet", json!({}))).unwrap();
    assert_eq!(
        greet.deserialize::<String>().unwrap(),
        "app command still works"
    );
    let echo = get_ipc_response(
        &webview,
        request(
            "rustra_dispatch",
            json!({"command":"echo","args":{"message":"coexists"}}),
        ),
    )
    .unwrap();
    assert_eq!(
        echo.deserialize::<Value>().unwrap(),
        json!({"message":"coexists"})
    );
    let received = Arc::new(Mutex::new(Vec::new()));
    let listener = received.clone();
    app.listen("rustra://setup_progress", move |event| {
        listener.lock().unwrap().push(event.payload().to_owned())
    });
    package().emit("setup.progress", json!({"ready":true}));
    assert_eq!(received.lock().unwrap().len(), 1);
}
