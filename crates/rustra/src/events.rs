//! Rust → JS 이벤트 푸시를 위한 구독 버스 + 푸시 싱크.
//!
//! `Package::emit(event, payload)` 로 발행된 이벤트를 호스트 어댑터가 전달받는
//! 경로는 두 가지다:
//!
//! 1. **폴링** — 이벤트가 [`EventBus`] 큐에 쌓이고, 호스트가
//!    `take_pending_events()` 로 주기적으로 꺼내 자기 플랫폼의 푸시 채널(Lynx BTS
//!    `post_task_to_runtime`, Tauri `emit`, RN `DeviceEventEmitter`)로 전달한다.
//! 2. **푸시** — [`Package::set_event_sink`] 로 [`EventSink`] 콜백을 등록하면
//!    `emit` 이 즉시 콜백을 호출한다. 폴링 루프가 없어도 되고 지연도 없다
//!    (LLM 토큰 스트리밍처럼 낮은 지연이 중요한 용도).
//!
//! 두 경로는 **상호 배타적**이다 — 싱크가 설치된 동안 `emit` 은 버스를 건너뛴다
//! (푸시+폴링을 함께 쓰는 호스트에서 같은 이벤트가 두 번 수신되는 것을 방지).
//! `set_event_sink(None)` 으로 해제하면 즉시 폴링 경로로 돌아간다.
//!
//! 설계 제약:
//! - 페이로드는 직렬화된 JSON `String`으로 저장한다 — 코드gen된 각 이벤트 타입과
//!   디커플링되고, 모든 어댑터가 이미 JSON 디코딩 경로를 갖는다.
//! - 큐는 고정 용량(기본 1024). 넘치면 가장 오래된 이벤트를 버리고
//!   `dropped` 카운터를 증가시킨다 — 호스트가 느리면 뒤처지는 것이지
//!   Rust 호출을 블록하지 않는다(backpressure 정책: drop-oldest).
//! - `Mutex` 하나로 보호한다 — 이벤트 빈도는 invoke 보다 훨씬 낮다는 가정.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

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

/// 발행된 단일 이벤트의 푸시 전달 콜백.
///
/// 호스트가 [`Package::set_event_sink`](crate::Package::set_event_sink) 로
/// 등록하면 `emit` 이 버스 적재 대신 이 콜백을 즉시 호출한다. 인자는
/// `(이벤트 이름, JSON 직렬화된 페이로드)`.
///
/// # 계약
///
/// - **스레드 안전**: 콜백은 `emit` 을 호출한 스레드에서 실행된다(어느 스레드에서든
///   호출될 수 있다). Tauri `Emitter::emit` 은 내부적으로 스레드 안전하지만,
///   JSI 처럼 런타임 스레드 친화성이 필요한 호스트는 콜백 안에서 자체
///   마샬링/큐잉을 해야 한다.
/// - **패닉 격리**: 콜백은 호스트 제공 코드다. 패닉하면 stderr 에 로그 남고
///   해당 emit 은 조용히 건너뛴다(패닉이 `emit` 호출자로 전파되지 않고,
///   싱크도 유지된다 — 다음 emit 에서 다시 시도한다).
/// - **전달 순서**: 동일 스레드에서 연속 `emit` 하면 호출 순서가 보장된다.
///   멀티 스레드 emit 의 전역 순서는 보장되지 않는다(폴링 경로의 `seq` 와 동일).
pub type EventSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// `EventBus` + `EventSink` 의 공유 상태. `Package` 가 `Arc` 로 들고 있어
/// `Package` clone 간에 싱크 설정이 공유된다.
pub(crate) struct EventState {
    pub(crate) bus: EventBus,
    pub(crate) sink: RwLock<Option<EventSink>>,
}

impl EventState {
    pub(crate) fn new() -> Self {
        Self {
            bus: EventBus::new(),
            sink: RwLock::new(None),
        }
    }

    /// 싱크가 설치되어 있으면 즉시 호출(true 반환 = 버스 우회), 없으면 false.
    ///
    /// 싱크 패닉은 잡아서 stderr 로그 후 건너뛴다 — emit 호출자(커맨드 핸들러)를
    /// 죽이지 않는다. 패닉 여부와 무관하게 싱크가 존재했으면 버스를 우회한다:
    /// "sink 있으면 bus 건너뛰기" 계약을 상태 의존적으로 흔들지 않기 위해.
    pub(crate) fn deliver_via_sink(&self, name: &str, payload: &str) -> bool {
        let sink = self.sink.read().unwrap().clone();
        let Some(sink) = sink else {
            return false;
        };
        if let Err(panic) = catch_unwind(AssertUnwindSafe(|| sink(name, payload))) {
            let panic_msg = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            eprintln!(
                "rustra: event sink panicked while delivering '{name}' ({panic_msg}) — event dropped (sink stays installed)"
            );
        }
        true
    }
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

    // ── EventSink (push 경로) ────────────────────────────────

    type Recorded = Arc<Mutex<Vec<(String, String)>>>;

    fn recording_sink(seen: Recorded) -> (Recorded, EventSink) {
        let sink_seen = Arc::clone(&seen);
        let sink: EventSink = Arc::new(move |name: &str, payload: &str| {
            sink_seen
                .lock()
                .unwrap()
                .push((name.to_string(), payload.to_string()));
        });
        (seen, sink)
    }

    #[test]
    fn sink_receives_event_and_bus_stays_empty() {
        let state = EventState::new();
        let (seen, sink) = recording_sink(Arc::new(Mutex::new(Vec::new())));
        state.sink.write().unwrap().replace(sink);

        assert!(state.deliver_via_sink("progress.tick", r#"{"value":1}"#));
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            ("progress.tick".to_string(), r#"{"value":1}"#.to_string())
        );
        assert_eq!(state.bus.take_pending_events().len(), 0);
    }

    #[test]
    fn no_sink_falls_back_to_bus() {
        let state = EventState::new();
        assert!(!state.deliver_via_sink("a", "1"));
        // 폴백은 호출자(Package::emit)가 버스에 적재한다.
        state.bus.emit("a", "1");
        assert_eq!(state.bus.take_pending_events().len(), 1);
    }

    #[test]
    fn clearing_sink_restores_bus_path() {
        let state = EventState::new();
        let (_, sink) = recording_sink(Arc::new(Mutex::new(Vec::new())));
        state.sink.write().unwrap().replace(sink);
        assert!(state.deliver_via_sink("a", "1"));

        state.sink.write().unwrap().take();
        assert!(!state.deliver_via_sink("b", "2"));
        state.bus.emit("b", "2");
        assert_eq!(state.bus.take_pending_events().len(), 1);
    }

    #[test]
    fn panicking_sink_does_not_propagate() {
        let state = EventState::new();
        state
            .sink
            .write()
            .unwrap()
            .replace(Arc::new(|_: &str, _: &str| {
                panic!("host sink exploded");
            }));
        // 패닉이 밖으로 새지 않고, 싱크 설치 상태는 유지된다(다음 emit 재시도).
        assert!(state.deliver_via_sink("boom", "1"));
        assert!(state.deliver_via_sink("boom", "2"));
    }

    #[test]
    fn sequential_sink_calls_preserve_order() {
        let state = EventState::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (_, sink) = recording_sink(Arc::clone(&seen));
        state.sink.write().unwrap().replace(sink);
        for i in 0..5 {
            state.deliver_via_sink("tick", &format!("{{\"i\":{i}}}"));
        }
        let events = seen.lock().unwrap().clone();
        let values: Vec<i64> = events
            .iter()
            .map(|(_, p)| {
                serde_json::from_str::<serde_json::Value>(p).unwrap()["i"]
                    .as_i64()
                    .unwrap()
            })
            .collect();
        assert_eq!(values, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn bus_drop_oldest_unaffected_by_sink_code() {
        // 싱크 코드가 추가되어도 버스 자체의 drop-oldest 정책은 변하지 않는다.
        let bus = EventBus::with_capacity(2);
        bus.emit("a", "1");
        bus.emit("b", "2");
        bus.emit("c", "3");
        let events = bus.take_pending_events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].name, "b");
        assert_eq!(bus.dropped_count(), 1);
    }
}
