/// 취소 체크포인트가 통합된 async 워커 dispatch (양쪽 async 엔트리 공용).
///
/// [`crate::cancel`] 레지스트리를 dispatch 직전에 조회해 `Cancelled` 상태면
/// 핸들러(`invoke_fn`)를 실행하지 않고 `cancelled` 에러 프레임을 만들어
/// `on_complete` 로 전달한다. 협력적 취소 계약:
///
/// - **체크포인트 전 취소** — 핸들러 미시작, `cancelled: ...` 에러 응답.
/// - **체크포인트 통과 후 취소** — 핸들러는 끝까지 실행되고 정상 결과 전달.
///
/// 체크포인트는 "cancel 이 먼저였으면 핸들러가 절대 시작하지 않는다"만
/// 보장한다. 응답 포맷 정합성을 위해 프레임 생성은 `serialize`(`err_response`
/// 와 동일한 경로)에 맡긴다 — JSON 경로는 `json_serialize`, postcard 경로는
/// `postcard_serialize_response` 를 넘긴다. `serialize` 는 `invoke_fn` 의
/// 응답 포맷과 일치해야 한다 (호스트가 두 경로의 프레임을 동일하게 디코딩).
///
/// `complete_invocation` 을 `on_complete` 이전에 호출한다 — 콜백 실행 중
/// 호스트가 `rustra_ffi_cancellation_status` 로 조회하면 이미 Unknown(0)을
/// 보게 되어 완결 순서가 명확해진다.
///
/// 완료는 Drop guard 로 구조적으로 보장된다 — 워커가 잔여 패닉(예: 취소
/// 레지스트리 락 포이즈닝 시 `status`/`complete_invocation` 의 expect)으로
/// 끝나도 엔트리 정리가 누락되지 않는다. 핸들러 패닉 자체는 `invoke_fn` 이
/// 가리키는 sync 진입점들의 `with_panic_guard` 가 에러 프레임으로 정규화한다
/// (unwind 없이 복귀). guard 의 drop 을 콜백 직전에 명시해 완료→콜백 순서를
/// 유지한다 — 호스트 콜백이 경계를 위반해도 complete 는 이미 실행된 상태다.
///
/// 완료 보장 guard 자체는 양쪽 async 워커(`run_worker`/`run_worker_into`)가
/// 파일 수준의 [`EnsureComplete`] 하나를 공유한다.
struct EnsureComplete(u64);
impl Drop for EnsureComplete {
    fn drop(&mut self) {
        crate::cancel::complete_invocation(self.0);
    }
}

fn run_worker(
    id: u64,
    bytes: Vec<u8>,
    user_data_raw: usize,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invoke_fn: unsafe extern "C" fn(*const u8, usize, *mut usize) -> *mut u8,
    serialize: fn(&FfiResponse) -> Vec<u8>,
) {
    let _ensure = EnsureComplete(id);
    let mut out_len = 0;
    let resp_ptr = if crate::cancel::status(id) == crate::cancel::Status::Cancelled {
        err_response(
            &crate::RustraError::cancelled("invocation cancelled before dispatch").to_string(),
            &mut out_len,
            serialize,
        )
    } else {
        unsafe { invoke_fn(bytes.as_ptr(), bytes.len(), &mut out_len) }
    };
    // 완료→콜백 순서 계약: guard 를 여기서 명시적으로 풀어 complete_invocation
    // 이 on_complete 이전에 실행됨을 보장한다.
    drop(_ensure);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, resp_ptr, out_len) };
    } else if !resp_ptr.is_null() {
        unsafe { rustra_ffi_free(resp_ptr, out_len) };
    }
}

/// caller-buffer async 워커 dispatch — [`run_worker`] 와 동일한 계약(취소
/// 체크포인트, complete→callback 순서, exactly-once)을 호출자 버퍼 변형으로
/// 실행한다.
///
/// 응답 크기가 `capacity` 이하면 `Package::invoke_rkyv_v2_into` 가 caller
/// 버퍼에 직접 기록하고 `owned=0` 으로 전달한다 — Rust heap 할당과 복사가
/// 없다. 부족하면 **같은 dispatch 안에서** heap 프레임으로 폴백해
/// `owned=1` 로 전달한다. sync `_into` 처럼 재시도로 돌아오지 않는다:
/// 재시도는 다른 워커 스레드에 배정될 수 있어(2워커 풀) thread-local probe
/// 캐시가 미스나며 비멱등 핸들러가 재실행된다. 단일 dispatch + owned 폴백은
/// 이 경합을 구조적으로 제거한다 — 핸들러는 어떤 경우에도 1회만 실행된다.
///
/// null 콜백이면 owned 프레임만 즉시 해제한다(caller 버퍼는 호스트 소유 —
/// 건드리지 않는다).
fn run_worker_into(job: AsyncIntoJob) {
    let AsyncIntoJob {
        id,
        bytes,
        buf_raw,
        capacity,
        user_data_raw,
        on_complete,
    } = job;
    let buf = buf_raw as *mut u8;
    let _ensure = EnsureComplete(id);

    let (resp_ptr, resp_len, owned) = if crate::cancel::status(id)
        == crate::cancel::Status::Cancelled
    {
        let frame = crate::encode_rkyv_v2_error(&crate::RustraError::cancelled(
            "invocation cancelled before dispatch",
        ));
        deliver_into_frame(frame, buf, capacity)
    } else {
        // null caller buffer — owned 프레임으로만 전달할 수 있다.
        let target: &mut [u8] = if buf.is_null() {
            &mut []
        } else {
            unsafe { std::slice::from_raw_parts_mut(buf, capacity) }
        };
        let direct = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            get_package()
                .ok_or_else(|| {
                    crate::RustraError::custom("ffi.not_registered", "package not registered")
                })
                .and_then(|pkg| pkg.invoke_rkyv_v2_into(&bytes, target))
        })) {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(&error))
            }
            Err(panic) => crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(
                &crate::RustraError::internal(panic_frame_message(&*panic)),
            )),
        };
        match direct {
            crate::rkyv_codec::DirectResponse::Written(written) => (buf, written, 0u8),
            crate::rkyv_codec::DirectResponse::Buffered(response) => {
                deliver_into_frame(response, buf, capacity)
            }
        }
    };

    // 완료→콜백 순서 계약 — run_worker 와 동일.
    drop(_ensure);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, resp_ptr, resp_len, owned) };
    } else if owned == 1 && !resp_ptr.is_null() {
        // 콜백이 없으면 소유권을 넘길 대상이 없다 — owned 프레임만 해제한다.
        // caller 버퍼(owned=0)는 호스트 소유라 해제하지 않는다.
        unsafe { rustra_ffi_free(resp_ptr, resp_len) };
    }
}

/// 응답 프레임 전달 규칙 — 들어가면 caller 버퍼로 복사(owned=0, 호스트가
/// 해제하지 않는다), 안 들어가면 `alloc_response` 포장으로 owned=1
/// (`rustra_ffi_free` 짝 — 기존 async 경로와 동일한 free 함수 하나로 수렴).
/// cancelled/error 프레임도 이 한 규칙을 따른다.
fn deliver_into_frame(frame: Vec<u8>, buf: *mut u8, capacity: usize) -> (*mut u8, usize, u8) {
    let needed = frame.len();
    if !buf.is_null() && capacity >= needed {
        unsafe { std::ptr::copy_nonoverlapping(frame.as_ptr(), buf, needed) };
        return (buf, needed, 0);
    }
    let mut out_len = 0usize;
    let ptr = alloc_response(frame, &mut out_len);
    (ptr, out_len, 1)
}
