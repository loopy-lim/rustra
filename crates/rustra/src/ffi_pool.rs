// ── async 워커 풀 (백프레셔 포함) ────────────────────────────
//
// 호출당 `std::thread::spawn` 은 burst 시 스레드 폭증(fd 고갈, 스케줄 지연)을
// 일으킨다. 이 풀은 고정 크기 워커 + bounded 채널로 대체한다 — 큐가 가득 차면
// 즉시 `invoke.backpressure` 에러 프레임으로 거부해 호출자(JsPromise)가 hang
// 없이 실패한다.

use std::sync::atomic::{AtomicU64, Ordering};

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
                            record_pool_completion();
                        }
                        Ok(AsyncTask::Into(job)) => {
                            run_worker_into(job);
                            record_pool_completion();
                        }
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
    let verdict = tx.try_send(job);
    // A08 overload 계측(최소 슬라이스) — 측정 근거 수집용 카운터. Relaxed 로
    // 충분하다: 정확한 스냅샷이 아니라 "백프레셔가 실제로 발생하는가"의 근거가
    // 목적이다. 제출 성공/거부는 여기서, 완료는 워커 루프에서 기록한다.
    match &verdict {
        Ok(()) => {
            ASYNC_SUBMITTED.fetch_add(1, Ordering::Relaxed);
            ASYNC_INFLIGHT.fetch_add(1, Ordering::Relaxed);
        }
        Err(_) => {
            ASYNC_REJECTED.fetch_add(1, Ordering::Relaxed);
        }
    }
    verdict.map_err(|e| match e {
        std::sync::mpsc::TrySendError::Full(job) => job,
        std::sync::mpsc::TrySendError::Disconnected(job) => job,
    })
}

// ── A08 overload 계측 카운터 ────────────────────────────────
//
// 안정화 통합 트랙(2026-09-05)의 A08 정의: "overload 계측 — 측정 근거 선행".
// 실행기 튜닝(워커 수·큐 깊이 노출, executor 주입)은 측정 근거가 쌓인 뒤
// 별도 트랙에서 결정한다. 이 슬라이스는 그 근거를 모으는 최소 계측이다:
// - submitted/rejected: 백프레셔 발생 빈도(`invoke.backpressure` 가 얼마나
//   자주 터지는가)와 투입량의 원시 근거.
// - completed/inflight: 완료 처리량과 순간 동시 잡 수(과부하 시 inflight 가
//   queue_depth + pool_size 근처에 붙는지 관찰).
// 오버헤드는 제출/완료당 AtomicU64 Relaxed 1회씩 — 핫 경계 프로파일
// (A07의 register_profiled)과 무관하게 상시 켠 채 둔다.
static ASYNC_SUBMITTED: AtomicU64 = AtomicU64::new(0);
static ASYNC_REJECTED: AtomicU64 = AtomicU64::new(0);
static ASYNC_COMPLETED: AtomicU64 = AtomicU64::new(0);
static ASYNC_INFLIGHT: AtomicU64 = AtomicU64::new(0);

/// 워커 루프의 잡 완료 기록 — run_worker/run_worker_into 반환은 곧 완료
/// (on_complete 호출 포함)를 뜻하므로 이 지점이 유일한 완료 체크포인트다.
fn record_pool_completion() {
    ASYNC_COMPLETED.fetch_add(1, Ordering::Relaxed);
    ASYNC_INFLIGHT.fetch_sub(1, Ordering::Relaxed);
}

/// async 워커 풀의 계측 스냅샷(A08 최소 슬라이스).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AsyncPoolStats {
    /// 고정 워커 수(`ASYNC_POOL_SIZE`).
    pub pool_size: usize,
    /// bounded 큐 깊이(`ASYNC_QUEUE_DEPTH`).
    pub queue_depth: usize,
    /// 제출 성공 누적.
    pub submitted: u64,
    /// 백프레셔(큐 가득/단절)로 즉시 거부된 누적 — `invoke.backpressure` 발생 근거.
    pub rejected: u64,
    /// 워커가 완료 처리한 잡 누적.
    pub completed: u64,
    /// 제출 후 아직 완료되지 않은 잡 수(근사 — 원자적 스냅샷이 아님).
    pub inflight: u64,
}

/// async 워커 풀 계측 스냅샷을 반환한다. 진단·측정용 — 완료 통계로 게이트를
/// 걸지 말 것(Relaxed 카운터는 근사치다).
pub fn async_pool_stats() -> AsyncPoolStats {
    AsyncPoolStats {
        pool_size: ASYNC_POOL_SIZE,
        queue_depth: ASYNC_QUEUE_DEPTH,
        submitted: ASYNC_SUBMITTED.load(Ordering::Relaxed),
        rejected: ASYNC_REJECTED.load(Ordering::Relaxed),
        completed: ASYNC_COMPLETED.load(Ordering::Relaxed),
        inflight: ASYNC_INFLIGHT.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod a08_tests {
    use super::*;

    unsafe extern "C" fn noop_invoke(
        _p: *const u8,
        _len: usize,
        _out_len: *mut usize,
    ) -> *mut u8 {
        std::ptr::null_mut()
    }

    #[test]
    fn stats_expose_pool_constants_and_monotonic_counters() {
        let before = async_pool_stats();
        assert_eq!(before.pool_size, ASYNC_POOL_SIZE);
        assert_eq!(before.queue_depth, ASYNC_QUEUE_DEPTH);

        // 잡 1건 제출 — null 반환 invoke_fn + null 콜백이라 워커가 안전하게
        // 소비한다(응답 프레임 없음, 해제 대상 없음).
        let ok = async_pool_submit(AsyncTask::Alloc((
            crate::cancel::register_invocation(),
            Vec::new(),
            0,
            None,
            noop_invoke,
            sync_serialize,
        )));
        assert!(ok.is_ok());

        // 워커가 소진할 때까지 스핀 대기(상한 5초 — CI 타임아웃 방지).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let after = loop {
            let s = async_pool_stats();
            if s.completed > before.completed || std::time::Instant::now() > deadline {
                break s;
            }
            std::thread::yield_now();
        };
        assert!(after.completed > before.completed, "worker did not complete the job within deadline: {after:?}");
        assert!(after.submitted > before.submitted);
        // 불변: 제출 = 완료 + 실행 중 + (경합 무시 근사) — inflight 는 음이 될 수 없다.
        assert!(after.inflight <= after.submitted);
    }
}
