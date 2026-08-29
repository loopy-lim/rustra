/// 전역 패키지에 C 콜백 기반 이벤트 싱크를 설치한다.
///
/// 설치 이후 `Package::emit` 은 이벤트 버스 적재 대신 즉시
/// `callback(user_data, name, payload)` 을 호출한다 — 각 인자는 NUL 종료 UTF-8
/// C 문자열 포인터다. `payload` 는 JSON 직렬화된 문자열 그대로다(파싱은 JS
/// 어댑터에서 1회).
///
/// # 스레드 계약
///
/// 콜백은 `emit` 을 호출한 **어느 스레드에서든** 실행될 수 있다. JSI 같은
/// 런타임 스레드 친화성이 필요한 호스트는 콜백 안에서 자체 큐잉 후 자기
/// 런타임 스레드(CallInvoker 등)로 마샬링해야 한다.
///
/// # 패닉 격리
///
/// 패닉은 [`events::EventState::deliver_via_sink`] 의 `catch_unwind` 이 가둔다
/// — 콜백이 패닉하면 stderr 로그 후 해당 이벤트가 소실되고 `emit` 은 정상
/// 복귀한다(싱크는 유지).
///
/// **되감기(unwind) 금지 계약**: C++ 호스트 콜백은 예외를 밖으로 던지면 안
/// 된다. Rust 패닉은 `catch_unwind` 으로 격리되지만, Rust 프레임을 통과하는
/// **외국(foreign) 예외**는 Rust 가 잡을 수 없어 정의된 즉시 abort 다
/// (`"C-unwind"` ABI 하에서 UB 대신 abort 로 보장된 것). C++ 콜백은
/// `noexcept` 로 표시하거나 최상위 `catch (...)` 로 삼키라.
///
/// # Safety
///
/// `callback` 은 유효한 함수 포인터여야 한다. `user_data` 는 호스트가 소유하며
/// [`rustra_ffi_event_sink_unregister`] 전까지(또는 교체 등록 직전까지) 유효해야
/// 한다. 이미 등록된 싱크가 있으면 조용히 교체한다(구 콜백은 더 이상 호출되지
/// 않는다 — 구 `user_data` 해제는 호스트 책임).
///
/// 해제/교체 등록은 진행 중인 콜백이 모두 반환할 때까지 기다린다. 함수가
/// 반환되면 구 `user_data`는 더 이상 호출되지 않으므로 호스트가 안전하게
/// 해제할 수 있다. 콜백 자신 안에서 동기 unregister/register를 호출하면 자기
/// 완료를 기다리는 교착이므로 금지한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_register(
    callback: FfiEventCallback,
    user_data: *mut c_void,
) {
    // catch_unwind: 전역 락이 이미 포이즈닝된 경우에도 등록 경로가 UB 를
    // 만들지 않게 한다(패닉은 stderr 로그만 남긴다).
    let _ = std::panic::catch_unwind(|| {
        let new_sink = FfiEventSink::new(callback, user_data);
        let mut guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = guard.replace(new_sink.clone());

        // 전역 패키지가 이미 등록되어 있으면 Rust 싱크를 설치한다. 미등록이면
        // 나중에 register_ffi() 가 호출될 때 install_pending_ffi_event_sink 가
        // 설치를 이어간다(지연 설치).
        if let Some(pkg) = get_package() {
            pkg.set_event_sink(Some(rust_event_sink(new_sink)));
        }
        drop(guard);
        if let Some(previous) = previous {
            previous.deactivate_and_wait();
        }
    });
}

/// 설치된 C 콜백 싱크를 제거하고 폴링(이벤트 버스) 경로로 되돌린다.
///
/// 제거 후 `emit` 은 다시 버스에 적재된다 — `take_pending_events` 폴링 호스트와
/// 상호 운용된다. 미등록 상태에서 호출해도 안전하다(no-op).
///
/// # Safety
///
/// 이 함수 자체는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의
/// 산물이다). 등록된 콜백의 `user_data` 소유권은 여전히 호스트에게 있다 —
/// 해제 시점은 호스트가 결정한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_unregister() {
    let _ = std::panic::catch_unwind(|| {
        let mut guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = guard.take();
        if let Some(pkg) = get_package() {
            pkg.set_event_sink(None);
        }
        drop(guard);
        if let Some(previous) = previous {
            previous.deactivate_and_wait();
        }
    });
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

impl Package {
    /// (내부용) FFI C 콜백 싱크가 등록되어 있으면 이 패키지에 설치한다.
    ///
    /// `register_ffi` 보다 `rustra_ffi_event_sink_register` 가 먼저 호출된 경우
    /// (패키지 미등록) 지연 설치를 위해 사용된다.
    fn install_pending_ffi_event_sink(&self) {
        // 전역 registry lock을 유지한 채 Package sink를 갱신해 unregister가
        // pending snapshot 이후 끼어들어 stale sink를 다시 설치하는 TOCTOU를
        // 막는다. emit 경로는 이 전역 lock을 읽지 않는다.
        let guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(sink) = guard.as_ref() {
            self.set_event_sink(Some(rust_event_sink(sink.clone())));
        }
    }
}
