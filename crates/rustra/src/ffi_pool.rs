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

/// The production owner has process lifetime. Owned pools drain and join on drop,
/// so tests exercise the same queue/worker code without detached global workers.
struct AsyncPool {
    sender: Mutex<Option<std::sync::mpsc::SyncSender<AsyncTask>>>,
    workers: Vec<std::thread::JoinHandle<()>>,
    counters: std::sync::Arc<PoolCounters>,
}

#[derive(Default)]
struct PoolCounters {
    submitted: AtomicU64,
    rejected: AtomicU64,
    completed: AtomicU64,
    inflight: AtomicU64,
}

impl AsyncPool {
    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AsyncTask>(ASYNC_QUEUE_DEPTH);
        let rx = std::sync::Arc::new(Mutex::new(rx));
        let mut pool = Self {
            sender: Mutex::new(Some(tx)),
            workers: Vec::with_capacity(ASYNC_POOL_SIZE),
            counters: std::sync::Arc::new(PoolCounters::default()),
        };
        for _ in 0..ASYNC_POOL_SIZE {
            let rx = std::sync::Arc::clone(&rx);
            let counters = std::sync::Arc::clone(&pool.counters);
            // A spawn panic drops the partially built pool and joins workers
            // already started, rather than detaching them.
            pool.workers.push(std::thread::spawn(move || {
                loop {
                    let job = rx.lock().unwrap_or_else(|p| p.into_inner()).recv();
                    let Ok(job) = job else { break };
                    match job {
                        AsyncTask::Alloc((
                            id,
                            bytes,
                            user_data_raw,
                            on_complete,
                            invoke_fn,
                            serialize,
                        )) => {
                            run_worker(id, bytes, user_data_raw, on_complete, invoke_fn, serialize);
                        }
                        AsyncTask::Into(job) => run_worker_into(job),
                    }
                    counters.inflight.fetch_sub(1, Ordering::Relaxed);
                    counters.completed.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        pool
    }

    fn submit(&self, job: AsyncTask) -> Result<(), AsyncTask> {
        let tx = self.sender.lock().unwrap_or_else(|p| p.into_inner());
        // Reserve before publishing: a fast worker must never decrement zero.
        self.counters.inflight.fetch_add(1, Ordering::Relaxed);
        match tx.as_ref().expect("live pool sender").try_send(job) {
            Ok(()) => {
                self.counters.submitted.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(error) => {
                self.counters.inflight.fetch_sub(1, Ordering::Relaxed);
                self.counters.rejected.fetch_add(1, Ordering::Relaxed);
                Err(match error {
                    std::sync::mpsc::TrySendError::Full(job)
                    | std::sync::mpsc::TrySendError::Disconnected(job) => job,
                })
            }
        }
    }

    fn stats(&self) -> AsyncPoolStats {
        self.counters.stats()
    }
}

impl Drop for AsyncPool {
    fn drop(&mut self) {
        // Disconnect first. Receivers drain accepted jobs, then return Err.
        self.sender
            .get_mut()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        for worker in self.workers.drain(..) {
            // Join every worker even if one unwound; do not double-panic in Drop.
            let _ = worker.join();
        }
    }
}

static ASYNC_POOL: OnceLock<AsyncPool> = OnceLock::new();

fn async_pool_submit(job: AsyncTask) -> Result<(), AsyncTask> {
    ASYNC_POOL.get_or_init(AsyncPool::new).submit(job)
}

impl PoolCounters {
    fn stats(&self) -> AsyncPoolStats {
        AsyncPoolStats {
            pool_size: ASYNC_POOL_SIZE,
            queue_depth: ASYNC_QUEUE_DEPTH,
            submitted: self.submitted.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
            completed: self.completed.load(Ordering::Relaxed),
            inflight: self.inflight.load(Ordering::Relaxed),
        }
    }
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
    ASYNC_POOL
        .get()
        .map(AsyncPool::stats)
        .unwrap_or_else(|| PoolCounters::default().stats())
}

#[cfg(test)]
mod a08_tests {
    use super::*;

    unsafe extern "C" fn noop_invoke(_p: *const u8, _len: usize, _out_len: *mut usize) -> *mut u8 {
        std::ptr::null_mut()
    }

    fn noop_task() -> AsyncTask {
        AsyncTask::Alloc((
            crate::cancel::register_invocation(),
            Vec::new(),
            0,
            None,
            noop_invoke,
            sync_serialize,
        ))
    }

    #[test]
    fn drop_drains_queued_jobs_and_joins_workers_repeatedly() {
        for _ in 0..3 {
            let pool = AsyncPool::new();
            let counters = std::sync::Arc::clone(&pool.counters);
            let mut ids = Vec::new();
            for _ in 0..16 {
                let job = noop_task();
                if let AsyncTask::Alloc((id, ..)) = &job {
                    ids.push(*id);
                }
                assert!(pool.submit(job).is_ok());
            }
            drop(pool);
            let stats = counters.stats();
            assert_eq!(stats.submitted, 16);
            assert_eq!(stats.completed, 16);
            assert_eq!(stats.inflight, 0);
            for id in ids {
                assert_eq!(crate::cancel::status(id), crate::cancel::Status::Unknown);
            }
        }
    }

    #[test]
    fn full_queue_rejects_without_losing_accepted_jobs() {
        static STARTED: std::sync::Barrier = std::sync::Barrier::new(3);
        static RELEASE: std::sync::Barrier = std::sync::Barrier::new(3);
        unsafe extern "C" fn blocked(_p: *const u8, _len: usize, _out: *mut usize) -> *mut u8 {
            STARTED.wait();
            RELEASE.wait();
            std::ptr::null_mut()
        }
        let pool = AsyncPool::new();
        for _ in 0..2 {
            assert!(
                pool.submit(AsyncTask::Alloc((
                    crate::cancel::register_invocation(),
                    Vec::new(),
                    0,
                    None,
                    blocked,
                    sync_serialize
                )))
                .is_ok()
            );
        }
        STARTED.wait();
        let accepted = (0..256)
            .filter(|_| pool.submit(noop_task()).is_ok())
            .count();
        let rejected = pool.submit(noop_task());
        let saturated = pool.stats();
        RELEASE.wait();
        let counters = std::sync::Arc::clone(&pool.counters);
        drop(pool);
        assert_eq!(accepted, 256);
        assert_eq!(saturated.inflight, 258);
        assert_eq!(saturated.rejected, 1);
        match rejected {
            Err(AsyncTask::Alloc((id, ..))) => crate::cancel::complete_invocation(id),
            _ => panic!("full queue accepted a job"),
        }
        assert_eq!(counters.stats().completed, 258);
        assert_eq!(counters.stats().inflight, 0);
    }

    #[test]
    fn stats_expose_pool_constants_and_monotonic_counters() {
        let pool = AsyncPool::new();
        let before = pool.stats();
        assert_eq!(before.pool_size, ASYNC_POOL_SIZE);
        assert_eq!(before.queue_depth, ASYNC_QUEUE_DEPTH);

        // 잡 1건 제출 — null 반환 invoke_fn + null 콜백이라 워커가 안전하게
        // 소비한다(응답 프레임 없음, 해제 대상 없음).
        let ok = pool.submit(AsyncTask::Alloc((
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
            let s = pool.stats();
            if s.completed > before.completed || std::time::Instant::now() > deadline {
                break s;
            }
            std::thread::yield_now();
        };
        assert!(
            after.completed > before.completed,
            "worker did not complete the job within deadline: {after:?}"
        );
        assert!(after.submitted > before.submitted);
        // 불변: 제출 = 완료 + 실행 중 + (경합 무시 근사) — inflight 는 음이 될 수 없다.
        assert!(after.inflight <= after.submitted);
        let counters = std::sync::Arc::clone(&pool.counters);
        drop(pool);
        assert_eq!(counters.stats().inflight, 0);
        assert_eq!(counters.stats().completed, 1);
    }
}
