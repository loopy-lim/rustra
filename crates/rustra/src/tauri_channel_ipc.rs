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
        // 2차 방어선 — 전송 계층 상한(16 MiB). 최대 페이로드 한도(기본 1 MiB,
        // `rustra_ffi_set_max_payload`) 초과 프레임은 이미 `ChannelHost::send`
        // 에서 잘려나가 `false` 로 보고되므로(리스크 감사 2026-09-13 #1), 이
        // 분기는 호스트가 한도를 이 상한 위로 올린 경우에만 도달한다. sender
        // 클로저 계약이 `Fn(&str)`/`Fn(&[u8])` 라 실패를 되돌려줄 수 없으므로
        // 여기서는 eprintln 진단을 남기고 드롭한다.
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
                // 채널이 멀티프레임 전송 도중 해제됐다(웹뷰 네비게이션/종료,
                // JS close). 남은 조각의 수신자는 이미 사라졌으므로 버리는 게
                // 맞고, 조각 스트림은 이 Sender 인스턴스의 `Channel` 락과
                // per-packet (len, offset) 헤더로만 구성되어 다른 채널을
                // 오염시킬 수 없다. 다만 유실은 관측 가능해야 하므로 잔여
                // 바이트와 함께 진단을 남긴다(무음 중단 금지 — 채널 유실점
                // 정비 2026-09-20).
                let undelivered = payload.len() - offset;
                let total = payload.len();
                let handle = self.handle;
                eprintln!(
                    "rustra: tauri channel deactivated mid-delivery — {undelivered} of {total} bytes undelivered (handle {handle})"
                );
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
