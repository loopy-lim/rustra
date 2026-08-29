/// 등록된 C 콜백 + 호스트 소유 `user_data`와 quiescence 상태.
struct FfiEventSinkInner {
    callback: FfiEventCallback,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    activity: Mutex<FfiEventActivity>,
    quiescent: std::sync::Condvar,
}

#[derive(Default)]
struct FfiEventActivity {
    enabled: bool,
    active_calls: usize,
}

#[derive(Clone)]
struct FfiEventSink(std::sync::Arc<FfiEventSinkInner>);

/// `FfiEventSinkInner.user_data` 는 호스트 소유 원시 포인터 — Rust 이동/빌림 규칙
/// 밖이다. 콜백 래퍼에서만 값으로 취급(역참조 없음)하므로 `Send + Sync` 선언이
/// 안전하다.
unsafe impl Send for FfiEventSinkInner {}
unsafe impl Sync for FfiEventSinkInner {}

struct FfiEventCallGuard<'a>(&'a FfiEventSinkInner);

impl Drop for FfiEventCallGuard<'_> {
    fn drop(&mut self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.active_calls = activity.active_calls.saturating_sub(1);
        if activity.active_calls == 0 {
            self.0.quiescent.notify_all();
        }
    }
}

impl FfiEventSink {
    fn new(callback: FfiEventCallback, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiEventSinkInner {
            callback,
            user_data,
            activity: Mutex::new(FfiEventActivity {
                enabled: true,
                active_calls: 0,
            }),
            quiescent: std::sync::Condvar::new(),
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
        {
            let mut activity = self
                .0
                .activity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !activity.enabled {
                return true; // 해제와 경합한 stale EventSink snapshot — 조용히 폐기
            }
            activity.active_calls += 1;
        }
        let _active = FfiEventCallGuard(&self.0);
        let Ok(name_c) = std::ffi::CString::new(name) else {
            return false;
        };
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return false;
        };
        unsafe { (self.0.callback)(self.0.user_data, name_c.as_ptr(), payload_c.as_ptr()) };
        true
    }

    /// 새 호출을 차단하고 이미 시작한 콜백이 모두 반환할 때까지 기다린다.
    fn deactivate_and_wait(&self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.enabled = false;
        while activity.active_calls != 0 {
            activity = self
                .0
                .quiescent
                .wait(activity)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

static FFI_EVENT_SINK: Mutex<Option<FfiEventSink>> = Mutex::new(None);
