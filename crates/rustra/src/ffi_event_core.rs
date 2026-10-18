#[derive(Default)]
struct FfiEventActivity {
    enabled: bool,
    active_calls: usize,
}

struct FfiActivityGate {
    activity: Mutex<FfiEventActivity>,
    quiescent: std::sync::Condvar,
}

impl FfiActivityGate {
    fn enter(&self) -> bool {
        let mut activity = self
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !activity.enabled {
            return false;
        }
        activity.active_calls += 1;
        true
    }

    fn wait_quiescent(&self) {
        let mut activity = self
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.enabled = false;
        while activity.active_calls != 0 {
            activity = self
                .quiescent
                .wait(activity)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

/// 진행 중 콜백 추적 guard — JSON/바이너리 sink 가 필드만 빌려 동일 계약으로
/// 쓴다(구체 타입에 의존하지 않는다).
struct FfiActivityGuard<'a> {
    gate: &'a FfiActivityGate,
}

impl Drop for FfiActivityGuard<'_> {
    fn drop(&mut self) {
        let mut activity = self
            .gate
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.active_calls = activity.active_calls.saturating_sub(1);
        if activity.active_calls == 0 {
            self.gate.quiescent.notify_all();
        }
    }
}

/// 등록된 C 콜백 + 호스트 소유 `user_data`와 quiescence 상태.
enum FfiEventCallbackKind {
    // 변형이 갖는 것은 콜백 ABI 그 자체다 — C-unwind(FfiEventCallback)와 plain C
    // (FfiScriptcEventCallback, scriptc 정적 링크 세계)는 포인터 시그니처가 같아도
    // 되감기 계약이 다르므로 하나의 fn pointer 로 뭉치면 안 된다.
    Unwind(FfiEventCallback),
    Plain(FfiScriptcEventCallback),
}

struct FfiEventSinkInner {
    callback: FfiEventCallbackKind,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    gate: FfiActivityGate,
}

#[derive(Clone)]
struct FfiEventSink(std::sync::Arc<FfiEventSinkInner>);

/// `FfiEventSinkInner.user_data` 는 호스트 소유 원시 포인터 — Rust 이동/빌림 규칙
/// 밖이다. 콜백 래퍼에서만 값으로 취급(역참조 없음)하므로 `Send + Sync` 선언이
/// 안전하다.
unsafe impl Send for FfiEventSinkInner {}
unsafe impl Sync for FfiEventSinkInner {}

impl FfiEventSink {
    fn new(callback: FfiEventCallback, user_data: *mut c_void) -> Self {
        Self::with_callback(FfiEventCallbackKind::Unwind(callback), user_data)
    }

    fn with_callback(callback: FfiEventCallbackKind, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiEventSinkInner {
            callback,
            user_data,
            gate: FfiActivityGate {
                activity: Mutex::new(FfiEventActivity {
                    enabled: true,
                    active_calls: 0,
                }),
                quiescent: std::sync::Condvar::new(),
            },
        }))
    }

    /// 저장된 콜백을 C ABI 로 호출한다. 문자열은 NUL 종료로 변환해 전달한다.
    ///
    /// 반환 `false` 는 name/payload 에 내부 NUL 이 있어 CString 변환에 실패해
    /// 이벤트가 소실되었다는 뜻이다(호출자가 로그로 처리). 해제 경합으로
    /// 콜백을 실행하지 못한 stale snapshot 의 경우 `true` 를 반환하는데, 이는
    /// "콘텐츠 문제로 소실"과 구분되며 상위 버스-우회 계약(싱크가 설치되어
    /// 있었으므로 폴링 버스로도 전달하지 않음)에는 그대로 부합한다.
    fn invoke(&self, name: &str, payload: &str) -> bool {
        if !self.0.gate.enter() {
            return true; // 해제와 경합한 stale EventSink snapshot — 조용히 폐기
        }
        let _active = FfiActivityGuard { gate: &self.0.gate };
        let Ok(name_c) = std::ffi::CString::new(name) else {
            return false;
        };
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return false;
        };
        unsafe {
            match self.0.callback {
                FfiEventCallbackKind::Unwind(callback) => {
                    callback(self.0.user_data, name_c.as_ptr(), payload_c.as_ptr());
                }
                FfiEventCallbackKind::Plain(callback) => {
                    callback(self.0.user_data, name_c.as_ptr(), payload_c.as_ptr());
                }
            }
        }
        true
    }

    /// 새 호출을 차단하고 이미 시작한 콜백이 모두 반환할 때까지 기다린다.
    fn deactivate_and_wait(&self) {
        self.0.gate.wait_quiescent();
    }
}

static FFI_EVENT_SINK: Mutex<Option<FfiEventSink>> = Mutex::new(None);

/// 전역 이벤트 싱크 교체/해제의 공통 순서 — 등록/해제 진입 4곳이 같은 정확성
/// 순서를 복사하지 않게 하나로 모은다. `next` 가 Some 이면 무조건 교체하고,
/// None 이면 `release_of` identity 가 현재 소유자와 일치할 때만 take 한다(소유
/// 확인과 take 는 같은 잠금 구간 안에 있어야 경합 아래에서 다른 소유자의 싱크를
/// 훔치지 않는다). 잠금 안에서 전역 교체와 패키지 싱크 설치를 끝내고, 가드를
/// 내린 뒤 구 싱크의 quiescence 를 기다린다 — 설치가 대기에 앞서고 대기가 가드
/// 밖이라는 순서가 정확성의 전부다. 패키지 미등록 시 설치는 이후 `register_ffi()`
/// 가 `install_pending_ffi_event_sink` 로 이어간다(지연 설치).
fn swap_global_event_sink(
    next: Option<FfiEventSink>,
    release_of: Option<(FfiScriptcEventCallback, *mut c_void)>,
) {
    let mut guard = FFI_EVENT_SINK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = match &next {
        Some(sink) => guard.replace(sink.clone()),
        None => {
            if let Some((callback, user_data)) = release_of {
                let owned = guard.as_ref().is_some_and(|sink| {
                    matches!(sink.0.callback, FfiEventCallbackKind::Plain(current)
                        if std::ptr::fn_addr_eq(current, callback)
                            && sink.0.user_data == user_data)
                });
                if !owned {
                    return;
                }
            }
            guard.take()
        }
    };
    if let Some(package) = get_package() {
        package.set_event_sink(next.map(rust_event_sink));
    }
    drop(guard);
    if let Some(previous) = previous {
        previous.deactivate_and_wait();
    }
}

/// C 콜백을 [`crate::events::EventSink`] 로 감싼 Rust 클로저를 만든다.
///
/// 콜백 스냅샷을 클로저에 캡처한다 — 등록 시점의 (callback, user_data) 쌍이
/// 그대로 호출되고, 재등록/해제는 `set_event_sink` 교체로 반영된다. emit 시점에
/// 전역 레지스트리를 다시 읽지 않으므로 재등록 직후 진행 중이던 emit 이 구
/// 콜백을 호출하는 창이 최소화된다(정확히 한 번 전달은 유지).
fn rust_event_sink(sink: FfiEventSink) -> crate::events::EventSink {
    std::sync::Arc::new(move |name: &str, payload: &str| {
        // name/payload 는 rustra 가 생성한 UTF-8 이므로 내부 NUL 변환 실패는
        // 사실상 불가 — 실패해도 이벤트 소실 로그만 남기고 패닉하지 않는다.
        if !sink.invoke(name, payload) {
            eprintln!("rustra: event name/payload contains interior NUL — event dropped");
        }
    })
}
