//! Registered IPC entrypoints offload synchronous rustra dispatch. The public
//! Rust helpers retain their existing signatures for direct host callers.
use super::{BatchRequest, BatchResponse, ProfiledResponse, RustraState, run_batch, run_profiled};
use serde_json::{Value, json};
use tauri::State;

pub(super) const PRODUCTION_ENDPOINTS: [&str; 6] = [
    "rustra_contract_hash",
    "rustra_dispatch",
    "rustra_dispatch_batch",
    "rustra_channel_create",
    "rustra_channel_create_bytes",
    "rustra_channel_drop",
];

pub(super) fn production_handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        rustra_contract_hash_ipc,
        rustra_dispatch_ipc,
        rustra_dispatch_batch_ipc,
        crate::tauri_channels::rustra_channel_create,
        crate::tauri_channels::rustra_channel_create_bytes,
        crate::tauri_channels::rustra_channel_drop
    ]
}

async fn on_blocking_pool<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Value> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            serde_json::to_value(crate::RustraError::internal(format!(
                "Tauri dispatch worker failed: {error}"
            )))
            .expect("RustraError serializes")
        })
}

#[tauri::command(rename = "rustra_contract_hash")]
pub(super) async fn rustra_contract_hash_ipc(
    state: State<'_, RustraState>,
    expected_hash: Option<String>,
) -> Result<String, Value> {
    let dispatch = state.dispatch.clone();
    on_blocking_pool(move || {
        let native_hash = dispatch.contract_hash()?;
        if let Some(expected) = expected_hash
            && native_hash != expected
        {
            return Err(json!({
                "code": "contract.mismatch",
                "message": format!("Tauri contract hash mismatch: native={native_hash} vs expected={expected}. Regenerate the client and rebuild the Rust host."),
                "retryable": false,
            }));
        }
        Ok(native_hash)
    })
    .await?
}

#[tauri::command(rename = "rustra_dispatch")]
pub(super) async fn rustra_dispatch_ipc(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    let dispatch = state.dispatch.clone();
    on_blocking_pool(move || dispatch.invoke_json(&command, args)).await?
}

#[tauri::command(rename = "rustra_dispatch_batch")]
pub(super) async fn rustra_dispatch_batch_ipc(
    state: State<'_, RustraState>,
    requests: Vec<BatchRequest>,
) -> Result<Vec<BatchResponse>, Value> {
    let dispatch = state.dispatch.clone();
    on_blocking_pool(move || run_batch(dispatch.as_ref(), requests)).await
}

#[tauri::command(rename = "rustra_dispatch_profiled")]
pub(super) async fn rustra_dispatch_profiled_ipc(
    state: State<'_, RustraState>,
    command: String,
    args: Value,
) -> Result<ProfiledResponse, Value> {
    let dispatch = state.dispatch.clone();
    on_blocking_pool(move || run_profiled(dispatch.as_ref(), &command, args)).await
}
