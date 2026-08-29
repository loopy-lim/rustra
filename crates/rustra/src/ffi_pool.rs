// ── async 워커 풀 (백프레셔 포함) ────────────────────────────
//
// 호출당 `std::thread::spawn` 은 burst 시 스레드 폭증(fd 고갈, 스케줄 지연)을
// 일으킨다. 이 풀은 고정 크기 워커 + bounded 채널로 대체한다 — 큐가 가득 차면
// 즉시 `invoke.backpressure` 에러 프레임으로 거부해 호출자(JsPromise)가 hang
// 없이 실패한다.

/// 워커 수 — RN/임베디드 호스트의 과도한 스레드 생성을 막는 고정 상수.
/// 코어 수 기반 스케일링은 호스트 런타임과 조율이 필요해 과잉 — 2로 시작해
/// 필요 시 노출한다.
const ASYNC_POOL_SIZE: usize = 2;
/// 큐 깊이 — 이 이상의 백로그는 backpressure 로 즉시 거부한다.
const ASYNC_QUEUE_DEPTH: usize = 256;

type AsyncJob = (
    u64,
    Vec<u8>,
    usize,
    Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    unsafe extern "C" fn(*const u8, usize, *mut usize) -> *mut u8,
    fn(&FfiResponse) -> Vec<u8>,
);

/// caller-buffer 비동기 잡 — [`run_worker_into`] 가 소비한다.
/// `buf`/`capacity` 는 호출자(호스트)가 소유한 응답 버퍼로, 완료 콜백이
/// 실행되는 동안 살아 있음이 FFI 계약으로 보장된다(콜백이 버퍼를 소비한 뒤
/// 호스트가 해제한다). `buf_raw` 는 raw 포인터 대신 `usize` 로 담는다 —
/// 기존 `user_data` 와 같은 관례로 잡이 `Send` 를 만족하게 한다(포인터를
/// 스레드 간 전달하는 것 자체는 FFI 계약상 안전 — 호스트가 콜백 종료까지
/// 수명을 보장한다).
struct AsyncIntoJob {
    id: u64,
    bytes: Vec<u8>,
    buf_raw: usize,
    capacity: usize,
    user_data_raw: usize,
    on_complete: Option<UnsafeIntoComplete>,
}

/// async into 완료 콜백 타입 — `(user_data, resp_ptr, resp_len, owned)`.
/// `owned=0` 이면 `resp_ptr` 은 호출자가 제공한 버퍼(호스트가 해제하지
/// 않는다), `owned=1` 이면 Rust heap 프레임(`rustra_ffi_free` 로 해제).
type UnsafeIntoComplete = unsafe extern "C" fn(*mut c_void, *mut u8, usize, u8);

/// 두 종류의 async 잡 — 기존 alloc 경로(튜플)와 caller-buffer 경로(구조체)를
/// 같은 풀/워커에서 실행한다.
enum AsyncTask {
    Alloc(AsyncJob),
    Into(AsyncIntoJob),
}

fn async_pool() -> &'static Mutex<std::sync::mpsc::SyncSender<AsyncTask>> {
    static POOL: OnceLock<Mutex<std::sync::mpsc::SyncSender<AsyncTask>>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AsyncTask>(ASYNC_QUEUE_DEPTH);
        // 수신자를 Arc 로 공유해 각 워커가 lock-recv 로 잡는다 — Mutex 가 잠기는
        // 동안 다른 워커는 대기하지만 recv 자체가 블로킹이라 실제 경합은 짧다.
        let rx = std::sync::Arc::new(Mutex::new(rx));
        for _ in 0..ASYNC_POOL_SIZE {
            let rx = std::sync::Arc::clone(&rx);
            std::thread::spawn(move || {
                loop {
                    let job = {
                        let guard = rx.lock().unwrap_or_else(|p| p.into_inner());
                        guard.recv()
                    };
                    match job {
                        Ok(AsyncTask::Alloc((
                            id,
                            bytes,
                            user_data_raw,
                            on_complete,
                            invoke_fn,
                            serialize,
                        ))) => {
                            run_worker(id, bytes, user_data_raw, on_complete, invoke_fn, serialize);
                        }
                        Ok(AsyncTask::Into(job)) => run_worker_into(job),
                        Err(_) => break, // 송신자 전원 해제(프로세스 종료) — 워커 종료
                    }
                }
            });
        }
        Mutex::new(tx)
    })
}

/// 풀에 작업을 제출한다 — 큐가 가득 차면 Err(백프레셔). 호출자는
/// `invoke.backpressure` 프레임으로 정규화한다.
fn async_pool_submit(job: AsyncTask) -> Result<(), AsyncTask> {
    let tx = async_pool()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tx.try_send(job).map_err(|e| match e {
        std::sync::mpsc::TrySendError::Full(job) => job,
        std::sync::mpsc::TrySendError::Disconnected(job) => job,
    })
}
