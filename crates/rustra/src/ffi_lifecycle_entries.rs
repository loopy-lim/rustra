/// async 엔트리에서 워커 spawn 에 실패했을 때 완료를 에러 프레임으로 전달한다.
///
/// `run_worker` 의 완료 경로(complete_invocation → on_complete)를 동일하게
/// 밟는다 — 호출자의 콜백 계약(정확히 1회 호출, 버퍼는 rustra_ffi_free 로
/// 해제)이 유지되고 레지스트리 엔트리도 정리된다.
fn deliver_spawn_failure(
    id: u64,
    user_data_raw: usize,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    serialize: fn(&FfiResponse) -> Vec<u8>,
    message: &str,
) {
    let frame = err_frame(message);
    let bytes = serialize(&frame);
    let mut out_len = bytes.len();
    let ptr = alloc_response(bytes, &mut out_len);
    crate::cancel::complete_invocation(id);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, ptr, out_len) };
    } else if !ptr.is_null() {
        // 콜백이 없으면 소유권을 넘길 대상이 없다. 성공 워커의 null-callback
        // 경로와 동일하게 즉시 해제해 payload-too-large/backpressure 반복 시
        // 응답 버퍼가 누적되지 않게 한다.
        unsafe { rustra_ffi_free(ptr, out_len) };
    }
}

/// 진행 중인 async 호출을 취소한다 (협력적).
///
/// `Running` 상태의 호출만 취소 가능 — 이미 완료/취소된 ID는 false 반환.
/// 취소는 플래그 전환만 하고 스레드를 강제 종료하지 않는다.
///
/// 취소는 dispatch 체크포인트에서만 응답에 반영된다 — cancel 이 워커의
/// 체크포인트보다 먼저면 핸들러는 시작하지 않고 `cancelled` 에러 프레임이
/// `on_complete` 로 전달된다. 핸들러가 이미 시작했다면 취소는 결과를 바꾸지
/// 않는다: 실행은 끝까지 진행되고 정상 결과가 전달된다.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
/// 어떤 u64 값도 안전하다 — 알 수 없거나 이미 완료/취소된 ID 는 false 로
/// 정규화된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_cancel(invocation_id: u64) -> bool {
    crate::cancel::cancel_invocation(invocation_id)
}

/// 호출의 취소 상태 조회 (핸들러 내부 협력적 중단 폴링용).
///
/// 반환값: 0=Unknown(완료/미발급), 1=Running, 2=Cancelled.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
/// 어떤 u64 값도 정의된 상태 코드로 정규화된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_cancellation_status(invocation_id: u64) -> u32 {
    match crate::cancel::status(invocation_id) {
        crate::cancel::Status::Unknown => 0,
        crate::cancel::Status::Running => 1,
        crate::cancel::Status::Cancelled => 2,
    }
}

/// (T3) 페이로드 크기 한도를 동적으로 변경한다. 기본 1 MiB
/// (기본 1 MiB). 축소/확대 모두 즉시 이후의
/// `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard` 호출에 반영된다.
/// 비동기 변형(`rustra_ffi_invoke_async`/`_json_async`)은 호출자 스레드에서
/// 페이로드를 먼저 복사한 뒤에야 워커에서 검사한다 — 초과 페이로드도 일단
/// 복사되므로 일시적으로 메모리가 2배로 존재할 수 있다. 어떤 스레드든 호출할
/// 수 있고, 동시 set 간 경합은 last-writer-wins 이다.
///
/// `Relaxed` — 크기 게이트는 어림잡기(sanity gate) 용도라 원자성만 필요하고
/// 다른 메모리와의 순서 관계는 요구되지 않는다. 진행 중인 호출은 이미 읽은
/// 이전 한도로 검사를 마친 상태일 수 있다 (한도는 새 호출부터 적용).
///
/// # Safety
///
/// 어떤 값도 안전하다 — 0 으로 설정하면 모든 페이로드가 거부된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_set_max_payload(bytes: usize) {
    crate::limits::set_max_payload_bytes(bytes);
}

/// (T3) 현재 페이로드 크기 한도. [`rustra_ffi_set_max_payload`] 로 설정한
/// 값 또는 기본 1 MiB.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_max_payload() -> usize {
    max_payload_bytes()
}

/// Free a buffer previously returned by one of the `rustra_ffi_invoke_*` functions.
///
/// # Safety
///
/// - `ptr`/`len` must be the **exact** pointer and length returned by a
///   `rustra_ffi_invoke_*` call (or `ptr` may be null). Passing a `len` that
///   mismatches the original allocation reconstructs a `Box<[u8]>` with the
///   wrong layout — undefined behavior.
/// - Must not be called more than once for the same pointer (double-free is UB).
/// - In debug builds, both misuse modes are checked against a live-allocation
///   set and, on detection, the process **aborts** with a diagnostic on stderr
///   (continuing past a confirmed UB misuse is unsound; a panic cannot unwind
///   through this `extern "C"` boundary). Release builds rely on the caller
///   safety contract — the guard compiles out.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_free(ptr: *mut u8, _len: usize) {
    if !ptr.is_null() {
        #[cfg(debug_assertions)]
        match free_guard::check(ptr, _len, free_guard::AllocationKind::Header) {
            free_guard::Verdict::Sound => {}
            verdict => {
                eprintln!(
                    "rustra_ffi_free: F2 misuse ({verdict:?}) for (ptr,len)=({ptr:p},{_len}) — \
                     aborting to avoid UB. Call with the exact (ptr,len) returned by a \
                     rustra_ffi_invoke_* function, exactly once."
                );
                std::process::abort();
            }
        }

        unsafe {
            let header_ptr = ptr.sub(FFI_HEADER_SIZE);
            let magic = u32::from_le_bytes(*(header_ptr as *const [u8; 4]));
            let alloc_len = u32::from_le_bytes(*(header_ptr.add(4) as *const [u8; 4])) as usize;

            if magic != FFI_MAGIC {
                eprintln!(
                    "rustra_ffi_free: invalid magic 0x{magic:08x} at {ptr:p} (double-free or foreign pointer) — rejecting free to prevent UB"
                );
                return;
            }

            // Invalidate magic to prevent double-free
            std::ptr::write_bytes(header_ptr, 0, 4);

            let total_len = FFI_HEADER_SIZE + alloc_len;
            let raw_slice = std::slice::from_raw_parts_mut(header_ptr, total_len);
            let _ = Box::from_raw(raw_slice as *mut [u8]);
        }
    }
}

/// Free the exact pointer/length pair returned by `rustra_ffi_invoke_buffer`.
/// This allocation has no hidden header and is deliberately not interchangeable
/// with [`rustra_ffi_free`].
///
/// # Safety
///
/// `ptr` and `len` must be the exact pair returned by
/// `rustra_ffi_invoke_buffer`, exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_free_owned_bytes(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    #[cfg(debug_assertions)]
    match free_guard::check(ptr, len, free_guard::AllocationKind::Owned) {
        free_guard::Verdict::Sound => {}
        verdict => {
            eprintln!(
                "rustra_ffi_free_owned_bytes: F2 misuse ({verdict:?}) for (ptr,len)=({ptr:p},{len})"
            );
            std::process::abort();
        }
    }
    let raw_slice = std::ptr::slice_from_raw_parts_mut(ptr, len);
    let _ = unsafe { Box::from_raw(raw_slice) };
}
