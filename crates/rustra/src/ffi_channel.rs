// ── 채널 FFI (타입 패리티 2단계 — Tauri ipc::Channel 모델) ──────────────
// 호스트(C++ JSI 등)가 채널 핸들을 발급/해제하고, Rust 커맨드 핸들러가
// `rustra_ffi_channel_send` 로 호출 귀속 역방향 스트림을 흘린다.
// 이벤트 싱크(브로드캐스트)와 달리 채널은 유니캐스트 회신이다 —
// crates/rustra/src/channels.rs 의 계약 문서 참고.

/// 호스트 채널 수신 콜백 — `rustra_ffi_channel_create` 로 등록한다.
///
/// `handle` 는 발급 시 부여된 채널 번호(호스트가 핸들별 JS 콜백을 찾는 키),
/// `payload` 는 NUL 종결 C 문자열(JSON — 이벤트 싱크와 동일 인코딩).
/// 채널은 C-unwind 가 아니라 C ABI 다: `channels::ChannelHost::send` 가
/// 콜백 패닉을 잡아 무시하므로 호스트 콜백은 unwind 하지 않아도 된다.
pub type FfiChannelCallback =
    unsafe extern "C" fn(user_data: *mut c_void, handle: u32, payload: *const c_char);

/// 호스트 바이너리 채널 수신 콜백 — `rustra_ffi_channel_create_bytes` 로 등록한다.
///
/// `payload`/`payload_len` 은 콜백 반환 전까지만 유효하다(호스트는 복사한다).
/// JSON 경로와 동일한 핸들 공간·quiescence 계약을 쓴다.
pub type FfiChannelBytesCallback = unsafe extern "C" fn(
    user_data: *mut c_void,
    handle: u32,
    payload: *const u8,
    payload_len: usize,
);

/// FFI 채널 콜백 래퍼 — `FfiEventSink` 와 동일한 quiescence 계약으로
/// drop 반환 뒤에는 host `user_data`를 참조하는 콜백이 남지 않게 한다.
struct FfiChannelSinkInner {
    callback: FfiChannelCallback,
    handle: u32,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    gate: FfiActivityGate,
}

#[derive(Clone)]
struct FfiChannelSink(std::sync::Arc<FfiChannelSinkInner>);

unsafe impl Send for FfiChannelSinkInner {}
unsafe impl Sync for FfiChannelSinkInner {}

impl FfiChannelSink {
    fn new(callback: FfiChannelCallback, handle: u32, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiChannelSinkInner {
            callback,
            handle,
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

    fn invoke(&self, payload: &str) {
        if !self.0.gate.enter() {
            return;
        }
        let _active = FfiActivityGuard { gate: &self.0.gate };
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return; // 내부 NUL — 이벤트 싱크와 동일하게 소실(로그 없음, 채널은 유니캐스트)
        };
        unsafe { (self.0.callback)(self.0.user_data, self.0.handle, payload_c.as_ptr()) };
    }

    fn deactivate_and_wait(&self) {
        self.0.gate.wait_quiescent();
    }
}

static FFI_CHANNEL_SINKS: Mutex<std::collections::BTreeMap<u32, FfiChannelSink>> =
    Mutex::new(std::collections::BTreeMap::new());

struct FfiChannelBytesSinkInner {
    callback: FfiChannelBytesCallback,
    handle: u32,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    gate: FfiActivityGate,
}

#[derive(Clone)]
struct FfiChannelBytesSink(std::sync::Arc<FfiChannelBytesSinkInner>);

unsafe impl Send for FfiChannelBytesSinkInner {}
unsafe impl Sync for FfiChannelBytesSinkInner {}

impl FfiChannelBytesSink {
    fn new(callback: FfiChannelBytesCallback, handle: u32, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiChannelBytesSinkInner {
            callback,
            handle,
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

    fn invoke(&self, payload: &[u8]) {
        if !self.0.gate.enter() {
            return;
        }
        let _active = FfiActivityGuard { gate: &self.0.gate };
        unsafe {
            (self.0.callback)(
                self.0.user_data,
                self.0.handle,
                payload.as_ptr(),
                payload.len(),
            )
        };
    }

    fn deactivate_and_wait(&self) {
        self.0.gate.wait_quiescent();
    }
}

static FFI_CHANNEL_BYTES_SINKS: Mutex<std::collections::BTreeMap<u32, FfiChannelBytesSink>> =
    Mutex::new(std::collections::BTreeMap::new());

/// 호스트 채널을 등록하고 새 핸들(≥1, 단조 증가)을 반환한다.
///
/// 커맨드 인자 `ChannelHandle(u32)` 로 이 값을 JS 에서 전달한다. 콜백의
/// 두 번째 인자로 이 핸들이 다시 전달되므로 호스트는 핸들→JS 콜백
/// 룩업만 하면 된다.
///
/// # Safety
///
/// `callback` 은 유효한 함수 포인터, `user_data` 는 호스트 소유다. 반환된
/// 핸들은 `rustra_ffi_channel_drop` 전까지 유효하며, drop은 이미 시작한 콜백이
/// 모두 반환할 때까지 기다린다. drop 반환 뒤 host가 `user_data`를 해제해도
/// 안전하다. 콜백 안에서 자기 핸들을 동기 drop하면 교착하므로 금지한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_create(
    callback: FfiChannelCallback,
    user_data: *mut c_void,
) -> u32 {
    // 두 단계: 핸들 선발급 → 핸들을 캡처한 콜백 등록. register_channel 이
    // 핸들을 반환하므로 sink 생성 시점에 번호가 필요하다(선발급 후 insert).
    let host = crate::channels::host();
    let handle = host.reserve_handle();
    if handle == 0 {
        return 0;
    }
    let sink = FfiChannelSink::new(callback, handle, user_data);
    FFI_CHANNEL_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(handle, sink.clone());
    let sender: crate::channels::ChannelSender =
        std::sync::Arc::new(move |payload: &str| sink.invoke(payload));
    host.register_channel_with_handle(handle, sender);
    handle
}

/// 바이너리 채널을 발급한다 — 계약은 `rustra_ffi_channel_create` 와 동일하되
/// 콜백이 `const uint8_t*` + 길이를 받는다(Frame 프레임 등 임의 바이트).
///
/// # Safety
///
/// `callback`/`user_data` 계약은 `rustra_ffi_channel_create` 와 동일하다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_create_bytes(
    callback: FfiChannelBytesCallback,
    user_data: *mut c_void,
) -> u32 {
    let host = crate::channels::host();
    let handle = host.reserve_handle();
    if handle == 0 {
        return 0;
    }
    let sink = FfiChannelBytesSink::new(callback, handle, user_data);
    FFI_CHANNEL_BYTES_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(handle, sink.clone());
    let sender: crate::channels::ChannelBytesSender =
        std::sync::Arc::new(move |payload: &[u8]| sink.invoke(payload));
    host.register_channel_bytes_with_handle(handle, sender);
    handle
}

/// 바이너리 채널로 페이로드를 흘린다. 핸들이 유효하면 1, 만료/미등록/JSON
/// 경로 핸들이면 0.
///
/// # Safety
///
/// `payload` 는 호출 기간 동안 유효한 읽기 가능 메모리다. 이 함수 자체는
/// 안전하다(조용한 bool 반환).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_send_bytes(
    handle: u32,
    payload: *const u8,
    payload_len: usize,
) -> i32 {
    let payload = if payload.is_null() || payload_len == 0 {
        &[][..]
    } else {
        // Safety: caller guarantees readable `payload_len` bytes at `payload`.
        unsafe { std::slice::from_raw_parts(payload, payload_len) }
    };
    i32::from(crate::channels::host().send_bytes(handle, payload))
}

/// 채널로 JSON 페이로드을 흘린다. 핸들이 유효하면 1(도달), 만료/미등록이면 0.
///
/// # Safety
///
/// `payload` 는 NUL 종결 문자열. 이 함수 자체는 안전하다(조용한 bool 반환).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_send(handle: u32, payload: *const c_char) -> i32 {
    let payload = if payload.is_null() {
        String::new()
    } else {
        // Safety: caller guarantees NUL-terminated readable string.
        unsafe { std::ffi::CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned()
    };
    i32::from(crate::channels::host().send(handle, &payload))
}

/// 채널을 해제한다(호출 완료/취소 시). 성공 해제면 1, 없으면 0. 이후
/// 동일 핸들 send 는 0 — 핸들 번호는 재사용되지 않는다.
///
/// # Safety
///
/// 이 함수 자체는 안전하다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_drop(handle: u32) -> i32 {
    let host_removed = crate::channels::host().drop_channel(handle);
    let sink = FFI_CHANNEL_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&handle);
    if let Some(sink) = sink.as_ref() {
        sink.deactivate_and_wait();
    }
    let bytes_sink = FFI_CHANNEL_BYTES_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&handle);
    if let Some(sink) = bytes_sink.as_ref() {
        sink.deactivate_and_wait();
    }
    i32::from(host_removed || sink.is_some() || bytes_sink.is_some())
}
