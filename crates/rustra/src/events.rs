//! Rust → JS 이벤트 푸시를 위한 구독 버스.
//!
//! `Package::emit(event, payload)` 로 발행된 이벤트를 호스트 어댑터가
//! `take_pending_events()` 로 폴링해 자기 플랫폼의 푸시 채널(Lynx BTS
//! `post_task_to_runtime`, Tauri `emit`, RN `DeviceEventEmitter`)로 전달한다.
//!
//! 설계 제약:
//! - 페이로드는 직렬화된 JSON `String`으로 저장한다 — 코드gen된 각 이벤트 타입과
//!   디커플링되고, 모든 어댑터가 이미 JSON 디코딩 경로를 갖는다.
//! - 큐는 고정 용량(기본 1024). 넘치면 가장 오래된 이벤트를 버리고
//!   `dropped` 카운터를 증가시킨다 — 호스트가 느리면 뒤처지는 것이지
//!   Rust 호출을 블록하지 않는다(backpressure 정책: drop-oldest).
//! - `Mutex` 하나로 보호한다 — 이벤트 빈도는 invoke 보다 훨씬 낮다는 가정.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 발행된 단일 이벤트.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RustraEvent {
    /// 이벤트 이름 (예: `"progress.tick"`).
    pub name: String,
    /// JSON 직렬화된 페이로드.
    pub payload: String,
    /// 단조 증가 시퀀스 번호 — 호스트가 순서 검증에 사용.
    pub seq: u64,
}

#[derive(Debug, Default)]
struct EventBusState {
    queue: VecDeque<RustraEvent>,
    dropped: u64,
}

/// 고정 용량 이벤트 큐를 가진 버스. `Arc`로 `Package`와 호스트 어댑터가 공유한다.
#[derive(Debug, Clone)]
pub struct EventBus {
    state: Arc<Mutex<EventBusState>>,
    capacity: usize,
    seq: Arc<AtomicU64>,
}

impl EventBus {
    /// 용량 1024 버스를 만든다.
    pub fn new() -> Self {
        Self::with_capacity(1024)
    }

    /// 용량을 지정해 버스를 만든다.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(EventBusState::default())),
            capacity: capacity.max(1),
            seq: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 이벤트를 발행한다. 큐가 가득 차면 가장 오래된 이벤트를 버린다(drop-oldest).
    pub fn emit(&self, name: impl Into<String>, payload_json: impl Into<String>) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let event = RustraEvent {
            name: name.into(),
            payload: payload_json.into(),
            seq,
        };
        let mut state = self.state.lock().unwrap();
        if state.queue.len() >= self.capacity {
            state.queue.pop_front();
            state.dropped += 1;
        }
        state.queue.push_back(event);
    }

    /// 큐에 쌓인 이벤트를 전부 꺼낸다(소비). 호스트 폴링 루프에서 호출.
    pub fn take_pending_events(&self) -> Vec<RustraEvent> {
        let mut state = self.state.lock().unwrap();
        std::mem::take(&mut state.queue).into_iter().collect()
    }

    /// 대기 중 이벤트 수.
    pub fn pending_len(&self) -> usize {
        self.state.lock().unwrap().queue.len()
    }

    /// 용량 초과로 버려진 이벤트 누적 수.
    pub fn dropped_count(&self) -> u64 {
        self.state.lock().unwrap().dropped
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_and_take_roundtrip() {
        let bus = EventBus::new();
        bus.emit("progress.tick", r#"{"value":42}"#);
        bus.emit("progress.done", "{}");
        let events = bus.take_pending_events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].name, "progress.tick");
        assert_eq!(events[0].payload, r#"{"value":42}"#);
        assert_eq!(events[0].seq, 0);
        assert_eq!(events[1].seq, 1);
        assert_eq!(bus.pending_len(), 0);
    }

    #[test]
    fn drop_oldest_on_overflow() {
        let bus = EventBus::with_capacity(2);
        bus.emit("a", "1");
        bus.emit("b", "2");
        bus.emit("c", "3"); // a 가 버려진다
        let events = bus.take_pending_events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].name, "b");
        assert_eq!(bus.dropped_count(), 1);
    }

    #[test]
    fn seq_is_monotonic_across_takes() {
        let bus = EventBus::new();
        bus.emit("a", "1");
        let _ = bus.take_pending_events();
        bus.emit("b", "2");
        let events = bus.take_pending_events();
        assert_eq!(events[0].seq, 1);
    }

    #[test]
    fn shared_clone_sees_same_queue() {
        let bus = EventBus::new();
        let clone = bus.clone();
        clone.emit("x", "1");
        assert_eq!(bus.pending_len(), 1);
    }
}
