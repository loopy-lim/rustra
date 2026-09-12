//! Keep IPC callbacks on Tauri's direct, WebView-bound path. Large Tauri Channel
//! messages otherwise use an app-wide fetch queue. Every packet here is <=968
//! bytes, below Tauri 2.11's 1024-byte raw-message threshold.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::ipc::{Channel, InvokeResponseBody};

pub(super) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 960;

pub(super) struct Sender {
    channel: Mutex<Channel<InvokeResponseBody>>,
    active: Arc<AtomicBool>,
    handle: u32,
}

impl Sender {
    pub(super) fn new(
        channel: Channel<InvokeResponseBody>,
        active: Arc<AtomicBool>,
        handle: u32,
    ) -> Self {
        Self {
            channel: Mutex::new(channel),
            active,
            handle,
        }
    }

    pub(super) fn send(&self, payload: &[u8]) {
        let limit = crate::limits::max_payload_bytes().min(MAX_FRAME_BYTES);
        if payload.len() > limit {
            eprintln!(
                "rustra: tauri channel payload exceeds {limit} bytes (handle {})",
                self.handle
            );
            return;
        }
        // Serialize complete frames so concurrent producers cannot interleave
        // chunks. No global channel-table/ownership lock is held during delivery.
        let channel = self.channel.lock().unwrap_or_else(|p| p.into_inner());
        let mut offset = 0;
        loop {
            if !self.active.load(Ordering::Acquire) {
                return;
            }
            let end = (offset + CHUNK_BYTES).min(payload.len());
            let mut packet = Vec::with_capacity(8 + end - offset);
            packet.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            packet.extend_from_slice(&(offset as u32).to_le_bytes());
            packet.extend_from_slice(&payload[offset..end]);
            if let Err(error) = channel.send(InvokeResponseBody::Raw(packet)) {
                eprintln!(
                    "rustra: tauri channel send failed (handle {}): {error}",
                    self.handle
                );
                return;
            }
            if end == payload.len() {
                break;
            }
            offset = end;
        }
    }
}
