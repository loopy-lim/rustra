use rustra::{Package, channels, tauri_support};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindowBuilder};

fn invoke(webview: &tauri::WebviewWindow<MockRuntime>, command: &str, args: Value) -> Value {
    get_ipc_response(
        webview,
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
        },
    )
    .unwrap()
    .deserialize()
    .unwrap()
}

#[test]
fn ipc_json_and_bytes_channels_are_owned_by_the_calling_webview() {
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let captured = deliveries.clone();
    let builder = mock_builder().channel_interceptor(move |view, callback, _, body| {
        let payload = match body {
            InvokeResponseBody::Json(_) => panic!("channel packets must use bounded raw IPC"),
            InvokeResponseBody::Raw(bytes) => {
                assert!(bytes.len() < 1024);
                bytes.clone()
            }
        };
        captured
            .lock()
            .unwrap()
            .push((view.label().to_owned(), callback.0, payload));
        true
    });
    let app = tauri_support::register(Package::builder("ownership").build(), builder)
        .build(mock_context(noop_assets()))
        .unwrap();
    let owner = WebviewWindowBuilder::new(&app, "owner", Default::default())
        .build()
        .unwrap();
    let other = WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();
    for (command, prefix, binary) in [
        (
            "rustra_channel_create",
            tauri_support::CHANNEL_EVENT_PREFIX,
            false,
        ),
        (
            "rustra_channel_create_bytes",
            tauri_support::CHANNEL_BYTES_EVENT_PREFIX,
            true,
        ),
    ] {
        let handle = invoke(&owner, command, json!({"onMessage":"__CHANNEL__:123"}))["handle"]
            .as_u64()
            .unwrap() as u32;
        let leaked = Arc::new(Mutex::new(Vec::new()));
        let sink = leaked.clone();
        // Any-target event listeners are precisely the unsafe old boundary.
        app.listen_any(format!("{prefix}{handle}"), move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        deliveries.lock().unwrap().clear();
        let expected = if binary {
            vec![255; 4096]
        } else {
            serde_json::to_vec(&json!({"private":"가".repeat(10_000)})).unwrap()
        };
        if binary {
            assert!(channels::host().send_bytes(handle, &expected));
        } else {
            assert!(channels::host().send(handle, std::str::from_utf8(&expected).unwrap()));
        }
        let delivered = deliveries.lock().unwrap();
        assert!(delivered.len() > 1);
        let mut assembled = Vec::new();
        for (label, callback, packet) in delivered.iter() {
            assert_eq!(label, "owner");
            assert_eq!(*callback, 123);
            assert_eq!(
                u32::from_le_bytes(packet[..4].try_into().unwrap()) as usize,
                expected.len()
            );
            assert_eq!(
                u32::from_le_bytes(packet[4..8].try_into().unwrap()) as usize,
                assembled.len()
            );
            assembled.extend_from_slice(&packet[8..]);
        }
        assert_eq!(assembled, expected);
        drop(delivered);
        assert!(
            leaked.lock().unwrap().is_empty(),
            "other WebView must not receive the frame"
        );
        assert_eq!(
            invoke(&other, "rustra_channel_drop", json!({"handle":handle})),
            false
        );
        assert_eq!(
            invoke(&owner, "rustra_channel_drop", json!({"handle":handle})),
            true
        );
        assert_eq!(
            invoke(&owner, "rustra_channel_drop", json!({"handle":handle})),
            false
        );
    }
}

#[test]
fn app_scoped_host_handles_cannot_be_dropped_by_other_apps() {
    let first = tauri_support::register(Package::builder("first").build(), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let second = tauri_support::register(Package::builder("second").build(), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let handle = tauri_support::create_channel_for(first.handle());
    assert!(!tauri_support::drop_channel_for(second.handle(), handle));
    assert!(tauri_support::drop_channel_for(first.handle(), handle));
}

#[test]
fn app_exit_releases_webview_and_host_channels() {
    let app = tauri_support::register(Package::builder("cleanup").build(), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let owner = WebviewWindowBuilder::new(&app, "owner", Default::default())
        .build()
        .unwrap();
    let handle = invoke(
        &owner,
        "rustra_channel_create",
        json!({"onMessage":"__CHANNEL__:123"}),
    )["handle"]
        .as_u64()
        .unwrap() as u32;
    let host_handle = tauri_support::create_channel_for(app.handle());
    app.cleanup_before_exit();
    assert!(!channels::host().send(handle, "null"));
    assert!(!channels::host().send(host_handle, "null"));
}
