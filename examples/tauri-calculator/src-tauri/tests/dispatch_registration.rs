//! A07 — profiled dispatch 등록 분리 (production 기본 노출 제거) 검증.
//!
//! Tauri invoke 는 handler 목록에 등록된 커맨드에만 도달한다. 따라서
//! production 기본 등록([`register`])에서 `rustra_dispatch_profiled` 가 빠지면
//! 노출이 꺼진다. MockRuntime headless IPC 로 세 가지를 증명한다:
//!
//! 1. `register()` 로 빌드한 앱에서 `rustra_dispatch_profiled` invoke →
//!    "Command ... not found" (기본 노출 꺼짐).
//! 2. `register_profiled()` 로 빌드 → `ProfiledResponse` 정상 응답
//!    (`ok`/`native_ns` 필드 계약 유지).
//! 3. 일반 `rustra_dispatch` 는 양쪽 등록 모두 정상 — 프로덕션 성능 무영향.
//!
//! `tauri::test::get_ipc_response` 가 하는 방식 그대로 실제 IPC 메시지를
//! 웹뷰에 주입한다 — 등록 목록( `generate_handler!` )과 커맨드 라우팅 전체를
//! 통과하는 증명 지점이다.

use rustra::tauri_support;
use rustra_calculator_example::calculator_package;
use serde_json::json;
use tauri::WebviewWindowBuilder;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

/// 등록 함수별 mock 앱 + IPC 주입용 메인 웹뷰. `register`/`register_profiled`
/// 어느 쪽이든 받도록 함수 포인터로 받는다.
fn build_app(
    register: fn(
        rustra::Package,
        tauri::Builder<tauri::test::MockRuntime>,
    ) -> tauri::Builder<tauri::test::MockRuntime>,
) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    let app = register(calculator_package(), tauri::test::mock_builder())
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("webview builds");

    // webview 는 app 참조를 간접적으로 들고 있지만 소유하지 않으므로, App 을
    // `std::mem::forget` 으로 의도적으로 살려 둔다 — drop 시 webview 의
    // manager 참조가 무효화된다. 테스트 프로세스 종료까지 살아 있어도
    // 무방하다(헤드리스 MockRuntime, 기존 event_push.rs 의 App 리턴 패턴과
    // 동일한 수명 논리).
    std::mem::forget(app);
    webview
}

fn invoke_request(command: &str, args: serde_json::Value) -> InvokeRequest {
    InvokeRequest {
        cmd: command.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("url parses"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

/// 등록된 커맨드는 Ok(JSON) — [`rustra_dispatch`] 의 성공 계약.
fn assert_dispatch_ok(webview: tauri::WebviewWindow<tauri::test::MockRuntime>) {
    let result = get_ipc_response(
        &webview,
        invoke_request(
            "rustra_dispatch",
            json!({
                "command": "addNumbers",
                "args": { "a": 20, "b": 22 }
            }),
        ),
    );
    let payload = result
        .map(|body| {
            body.deserialize::<serde_json::Value>()
                .expect("deserializable")
        })
        .expect("rustra_dispatch must be reachable in every registration");
    assert_eq!(payload["value"], json!(42));
}

/// ① production 기본 등록에는 profiled 커맨드가 없다 — 노출이 꺼진다.
#[test]
fn register_does_not_expose_profiled_dispatch() {
    let webview = build_app(tauri_support::register);
    let result = get_ipc_response(
        &webview,
        invoke_request(
            "rustra_dispatch_profiled",
            json!({
                "command": "addNumbers",
                "args": { "a": 20, "b": 22 }
            }),
        ),
    );
    let error = result.expect_err("profiled dispatch must be absent from the default registration");
    assert_eq!(
        error,
        json!("Command rustra_dispatch_profiled not found"),
        "미등록 커맨드는 Tauri 라우팅 단계에서 거부되어야 한다"
    );
}

/// ② 벤치 등록은 profiled 커맨드를 노출하고 `ProfiledResponse` 계약을 유지한다.
#[test]
fn register_profiled_exposes_profiled_dispatch() {
    let webview = build_app(tauri_support::register_profiled);
    let result = get_ipc_response(
        &webview,
        invoke_request(
            "rustra_dispatch_profiled",
            json!({
                "command": "addNumbers",
                "args": { "a": 20, "b": 22 }
            }),
        ),
    );
    let body = result.expect("profiled dispatch must be reachable via register_profiled");
    let response: serde_json::Value = body.deserialize().expect("JSON deserializable");
    assert_eq!(response["ok"], json!(true), "addNumbers must succeed");
    assert_eq!(response["result"]["value"], json!(42));
    assert!(
        response["native_ns"].as_u64().unwrap_or(0) > 0,
        "native timing must be measured (Instant 차분)"
    );
}

/// ③ 일반 dispatch 는 양쪽 등록 모두 정상 — 성능 무영향 증명.
#[test]
fn plain_dispatch_works_in_both_registrations() {
    let plain_webview = build_app(tauri_support::register);
    assert_dispatch_ok(plain_webview);

    let profiled_webview = build_app(tauri_support::register_profiled);
    assert_dispatch_ok(profiled_webview);
}
