use rustra::{Package, hot_core::JsonDispatch, tauri_support};
use rustra_calculator_example::calculator_package;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tauri::WebviewWindowBuilder;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

fn contract_request(expected: Option<&str>) -> InvokeRequest {
    InvokeRequest {
        cmd: "rustra_contract_hash".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(match expected {
            Some(hash) => json!({"expectedHash": hash}),
            None => json!({}),
        }),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.into(),
    }
}

#[test]
fn registered_native_contract_matches_generated_client_hash() {
    let registrations: [fn(Package, tauri::Builder<MockRuntime>) -> tauri::Builder<MockRuntime>;
        3] = [
        tauri_support::register,
        tauri_support::register_with_events,
        tauri_support::register_profiled,
    ];
    for register in registrations {
        let package = calculator_package();
        let expected = package.generate_typescript().unwrap().contract_hash;
        let app = register(package, mock_builder())
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "contract-probe", Default::default())
            .build()
            .unwrap();
        let body = get_ipc_response(&webview, contract_request(None))
            .expect("native contract endpoint must be registered");
        assert_eq!(body.deserialize::<Value>().unwrap(), json!(expected));
    }
}

struct SelectedDispatch(AtomicUsize);
impl JsonDispatch for SelectedDispatch {
    fn invoke_json(&self, _: &str, _: Value) -> Result<Value, Value> {
        Ok(Value::Null)
    }
    fn contract_hash(&self) -> Result<String, Value> {
        Ok(format!("selected-{}", self.0.load(Ordering::SeqCst)))
    }
}

#[test]
fn dispatch_registration_reads_the_selected_producers_live_contract() {
    let selected = Arc::new(SelectedDispatch(AtomicUsize::new(1)));
    let app = tauri_support::register_dispatch(selected.clone(), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "selected-contract", Default::default())
        .build()
        .unwrap();
    for generation in [1, 2] {
        selected.0.store(generation, Ordering::SeqCst);
        let body = get_ipc_response(&webview, contract_request(None)).unwrap();
        assert_eq!(
            body.deserialize::<Value>().unwrap(),
            json!(format!("selected-{generation}"))
        );
    }
}

struct LegacyDispatch;
impl JsonDispatch for LegacyDispatch {
    fn invoke_json(&self, _: &str, _: Value) -> Result<Value, Value> {
        Ok(Value::Null)
    }
}

#[test]
fn existing_custom_dispatchers_compile_and_report_unenforceable_contracts() {
    let app = tauri_support::register_dispatch(Arc::new(LegacyDispatch), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "legacy-contract", Default::default())
        .build()
        .unwrap();
    let error = get_ipc_response(&webview, contract_request(None)).unwrap_err();
    assert_eq!(error["code"], json!("contract.unenforceable"));
}

#[test]
fn actual_ipc_rejects_a_mismatched_expected_contract_before_dispatch() {
    let app = tauri_support::register(calculator_package(), mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "mismatch-contract", Default::default())
        .build()
        .unwrap();
    let error = get_ipc_response(&webview, contract_request(Some("outdated-client")))
        .expect_err("native contract handshake must reject a stale client");
    assert_eq!(error["code"], json!("contract.mismatch"));
}
