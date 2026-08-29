/// `EventBus` + `EventSink` 의 공유 상태. `Package` 가 `Arc` 로 들고 있어
/// `Package` clone 간에 싱크 설정이 공유된다.
pub(crate) struct EventState {
    pub(crate) bus: EventBus,
    pub(crate) sink: RwLock<Option<EventSink>>,
}

impl Default for EventState {
    fn default() -> Self {
        Self::with_capacity(1024)
    }
}

impl EventState {
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            bus: EventBus::with_capacity(capacity),
            sink: RwLock::new(None),
        }
    }

    /// 싱크가 설치되어 있으면 즉시 호출(true 반환 = 버스 우회), 없으면 false.
    ///
    /// 싱크 패닉은 잡아서 stderr 로그 후 건너뛴다 — emit 호출자(커맨드 핸들러)를
    /// 죽이지 않는다. 패닉 여부와 무관하게 싱크가 존재했으면 버스를 우회한다:
    /// "sink 있으면 bus 건너뛰기" 계약을 상태 의존적으로 흔들지 않기 위해.
    pub(crate) fn deliver_via_sink(&self, name: &str, payload: &str) -> bool {
        // 포이즈닝 관용 — 싱크 옵션 자체는 구조적으로 유효하다(ffi.rs 와 동일).
        let sink = self
            .sink
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
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
