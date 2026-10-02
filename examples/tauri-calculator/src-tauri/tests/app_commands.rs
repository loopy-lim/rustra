use rustra::{Package, RustraError, tauri_support};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindowBuilder};

#[tauri::command]
fn app_greet() -> &'static str {
    "hello from the app"
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
fn native_app_command_survives_rustra_registration() {
    let package = Package::builder("app.commands")
        .command("answer", |_: Value| Ok::<_, RustraError>(json!(42)))
        .build();
    let emit_package = package.clone();
    let app = tauri_support::with_app_commands(
        tauri_support::register_with_events(package, mock_builder()),
        tauri::generate_handler![app_greet],
    )
    .build(mock_context(noop_assets()))
    .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "app-commands", Default::default())
        .build()
        .unwrap();
    let greet = get_ipc_response(&webview, request("app_greet", json!({})))
        .expect("adding Rustra must preserve the app's own native commands");
    assert_eq!(
        greet.deserialize::<Value>().unwrap(),
        json!("hello from the app")
    );
    let answer = get_ipc_response(
        &webview,
        request("rustra_dispatch", json!({"command":"answer","args":{}})),
    )
    .unwrap();
    assert_eq!(answer.deserialize::<Value>().unwrap(), json!(42));
    let received = Arc::new(Mutex::new(Vec::new()));
    let listener = received.clone();
    app.listen("rustra://progress_tick", move |event| {
        listener.lock().unwrap().push(event.payload().to_owned());
    });
    emit_package.emit("progress.tick", json!({"value":42}));
    let events = received.lock().unwrap();
    assert_eq!(events.len(), 1, "event plugin must survive composition");
    assert_eq!(
        serde_json::from_str::<Value>(&events[0]).unwrap(),
        json!({"value":42})
    );
}

#[test]
fn app_handler_cannot_shadow_production_endpoints_or_enable_profiling() {
    let package = Package::builder("app.reserved")
        .command("answer", |_: Value| Ok::<_, RustraError>(json!(42)))
        .build();
    let calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = calls.clone();
    let app = tauri_support::with_app_commands(
        tauri_support::register(package, mock_builder()),
        move |invoke| {
            handler_calls.fetch_add(1, Ordering::SeqCst);
            invoke.resolver.resolve("app fallback");
            true
        },
    )
    .build(mock_context(noop_assets()))
    .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "reserved-commands", Default::default())
        .build()
        .unwrap();
    for (command, args) in [
        ("rustra_contract_hash", json!({})),
        ("rustra_dispatch", json!({"command":"answer","args":{}})),
        ("rustra_dispatch_batch", json!({"requests":[]})),
        ("rustra_channel_create", json!({})),
        ("rustra_channel_create_bytes", json!({})),
        ("rustra_channel_drop", json!({})),
    ] {
        let response = get_ipc_response(&webview, request(command, args));
        match response {
            Ok(body) => assert_ne!(
                body.deserialize::<Value>().unwrap(),
                json!("app fallback"),
                "{command} must belong to Rustra"
            ),
            Err(error) => assert_ne!(
                error,
                json!(format!("Command {command} not found")),
                "{command} must remain registered even when its arguments are invalid"
            ),
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "{command} must not reach the app handler"
        );
    }
    let error = get_ipc_response(
        &webview,
        request(
            "rustra_dispatch_profiled",
            json!({"command":"answer","args":{}}),
        ),
    )
    .unwrap_err();
    assert_eq!(error, json!("Command rustra_dispatch_profiled not found"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let custom = get_ipc_response(&webview, request("custom_app_command", json!({}))).unwrap();
    assert_eq!(
        custom.deserialize::<Value>().unwrap(),
        json!("app fallback")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn custom_dispatch_registration_keeps_its_selected_producer() {
    let package = Package::builder("app.selected")
        .command("answer", |_: Value| Ok::<_, RustraError>(json!(99)))
        .build();
    let app = tauri_support::with_app_commands(
        tauri_support::register_dispatch(Arc::new(package), mock_builder()),
        tauri::generate_handler![app_greet],
    )
    .build(mock_context(noop_assets()))
    .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "selected-producer", Default::default())
        .build()
        .unwrap();
    let answer = get_ipc_response(
        &webview,
        request("rustra_dispatch", json!({"command":"answer","args":{}})),
    )
    .unwrap();
    assert_eq!(answer.deserialize::<Value>().unwrap(), json!(99));
}
