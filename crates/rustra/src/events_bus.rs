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
        // 포이즈닝 관용 — 큐(VecDeque)+카운터는 구조적으로 유효하다.
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.queue.len() >= self.capacity {
            state.queue.pop_front();
            state.dropped += 1;
        }
        state.queue.push_back(event);
    }

    /// 큐에 쌓인 이벤트를 전부 꺼낸다(소비). 호스트 폴링 루프에서 호출.
    pub fn take_pending_events(&self) -> Vec<RustraEvent> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut state.queue).into_iter().collect()
    }

    /// 큐에 쌓인 이벤트 목록과 누적 드랍 수를 함께 꺼낸다.
    pub fn take_pending_events_with_stats(&self) -> (Vec<RustraEvent>, u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = std::mem::take(&mut state.queue).into_iter().collect();
        (events, state.dropped)
    }

    /// 대기 중 이벤트 수.
    pub fn pending_len(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .queue
            .len()
    }

    /// 용량 초과로 버려진 이벤트 누적 수.
    pub fn dropped_count(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dropped
    }

    /// 큐의 최대 수용량.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
