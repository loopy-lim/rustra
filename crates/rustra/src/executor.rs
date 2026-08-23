//! Safe, lightweight synchronous executor for async command functions.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread::{self, Thread};

struct ThreadWaker(Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

/// Blocks on the provided future on the current thread until completion.
///
/// # 실행기 제약 (호스트 통합 시 필독)
///
/// 이 실행기는 **현재 스레드를 park** 해 폴링한다. 두 가지 함의가 있다:
///
/// 1. **tokio 등 멀티스레드 런타임 안에서 호출되면 워커를 굶긴다.** async
///    `#[command]` 핸들러가 FFI/동기 invoke 경로로 실행되면 이 블로킹 park 이
///    런타임 워커 스레드를 점유한다 — 호스트가 자체 비동기 런타임을 쓴다면
///    핸들러를 `spawn_blocking` 으로 감싸거나, 완전한 비동기 dispatch 를
///    기다려야 한다.
/// 2. **핸들러가 spawn 한 태스크에서 `State<T>` 가 보이지 않는다.** 상태 주입은
///    [`crate::state`] 의 thread_local 컨텍스트로 전달되므로 같은 스레드에서만
///    유효하다 — 런타임 `spawn` 이 워커로 옮기면 `State` 조회는 `None` 이다.
///
/// waker 는 `Thread::unpark` 기반이라 단일 스레드 future 에서 정확하다 —
/// future 가 여러 스레드에서 깨워져도 park 카운트가 깨우는 쪽으로 소진된다.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let thread = thread::current();
    let waker = Waker::from(Arc::new(ThreadWaker(thread)));
    let mut cx = Context::from_waker(&waker);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(result) => return result,
            Poll::Pending => thread::park(),
        }
    }
}
