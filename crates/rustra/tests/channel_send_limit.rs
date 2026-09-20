//! 채널 send 페이로드 한도 계약 — 리스크 감사(2026-09-13 항목 1) 후속.
//!
//! 계약: `ChannelHost::send`/`send_bytes` 는 프레임이 현재 최대 페이로드 한도
//! (기본 1 MiB, `rustra_ffi_set_max_payload` 로 조정)를 초과하면 조용한
//! 성공이 아니라 `false` 를 반환한다 — invoke 의 `payload.too_large` 와
//! 대칭. 한도 이하 send 는 변경 전과 동일하게 `true` 이고 등록된 콜백에
//! 페이로드가 그대로 도달한다.

use std::ffi::c_void;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use rustra::channels::ChannelHost;
use rustra::ffi::{
    rustra_ffi_channel_create, rustra_ffi_channel_drop, rustra_ffi_channel_send,
    rustra_ffi_set_max_payload,
};

const MIB: usize = 1024 * 1024;

/// 한도 변경 테스트 직렬화 + 원복 guard — payload_robustness.rs 의
/// LIMIT_MUTEX/LimitGuard 패턴과 동일. `MAX_PAYLOAD_BYTES` 는 프로세스 전역
/// atomic 이라 이 바이너리의 테스트들이 병렬로 돌 때 서로 오염시키지 않게
/// 1 MiB 가정 테스트 전부가 이 뮤텍스를 잡는다. drop 이 한도를 원복하므로
/// 어설션 실패(panic) 이후 테스트도 오염된 한도를 보지 않는다.
static LIMIT_MUTEX: Mutex<()> = Mutex::new(());

/// `LIMIT_MUTEX` guard — drop 에서 한도를 기본 1 MiB 로 원복한다.
/// 필드는 락 홀드 자체가 목적이라 읽히지 않는다 (RAII).
#[allow(dead_code)]
struct LimitGuard(std::sync::MutexGuard<'static, ()>);

impl Drop for LimitGuard {
    fn drop(&mut self) {
        unsafe { rustra_ffi_set_max_payload(MIB) };
    }
}

/// 뮤텍스를 잡은 뒤 한도를 기준 상태(1 MiB)로 되돌리고 guard 를 반환한다.
/// 시작 전 원복은 이전 테스트 panic 의 뮤텍스 독을 `into_inner` 로 회복해야
/// 의미가 있다 (payload_robustness.rs 참고).
fn limit_guard() -> LimitGuard {
    let guard = LIMIT_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    unsafe { rustra_ffi_set_max_payload(MIB) };
    LimitGuard(guard)
}

/// 기본 1 MiB 한도에서 초과 프레임은 `false` 고 콜백에 도달하지 않는다.
/// 정확히 한도인 프레임은 통과한다 — invoke 크기 가드와 동일한 `>` 비교.
#[test]
fn over_limit_send_returns_false_and_delivers_nothing() {
    let _guard = limit_guard();
    let host = ChannelHost::default();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let handle = host.register_channel(Arc::new(move |_p| {
        hits2.fetch_add(1, Ordering::Relaxed);
    }));
    assert_eq!(handle, 1);

    let oversized = "x".repeat(MIB + 1);
    assert!(
        !host.send(handle, &oversized),
        "초과 프레임은 false 로 보고된다"
    );
    assert_eq!(
        hits.load(Ordering::Relaxed),
        0,
        "거부된 프레임은 콜백에 도달하면 안 된다"
    );

    // 경계 — at-limit 은 통과한다.
    let at_limit = "x".repeat(MIB);
    assert!(host.send(handle, &at_limit));
    assert_eq!(hits.load(Ordering::Relaxed), 1);
}

/// 한도 이하 send 는 변경 전과 동일하다 — `true` 반환, 페이로드 무손실 도달.
#[test]
fn under_limit_send_returns_true_and_delivers_payload() {
    let _guard = limit_guard();
    let host = ChannelHost::default();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |payload: &str| seen.lock().unwrap().push(payload.to_owned()))
    };
    let handle = host.register_channel(sink);

    let payload = "{\"chunk\":\"데이터\"}".repeat(64);
    assert!(host.send(handle, &payload));
    let delivered = seen.lock().unwrap();
    assert_eq!(delivered.len(), 1);
    assert_eq!(
        delivered[0], payload,
        "페이로드는 바이트 단위로 동일해야 한다"
    );
}

/// `rustra_ffi_set_max_payload` 로 한도를 낮추면 기존에 통과하던 send 가
/// `false` 로 바뀐다. 한도 복원 시 다시 통과 — 게이트가 상태를 남기지 않는다.
#[test]
fn lowered_limit_makes_previously_passing_send_fail() {
    let _guard = limit_guard();
    let host = ChannelHost::default();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let handle = host.register_channel(Arc::new(move |_p| {
        hits2.fetch_add(1, Ordering::Relaxed);
    }));

    let payload = "y".repeat(8 * 1024);
    // 기본 1 MiB 에서는 통과.
    assert!(host.send(handle, &payload));
    assert_eq!(hits.load(Ordering::Relaxed), 1);

    // 4 KiB 로 낮춘 뒤 같은 페이로드 — false, 유실.
    unsafe { rustra_ffi_set_max_payload(4 * 1024) };
    assert!(!host.send(handle, &payload));
    assert_eq!(hits.load(Ordering::Relaxed), 1);

    // 한도 복원 — 즉시 다시 통과.
    unsafe { rustra_ffi_set_max_payload(MIB) };
    assert!(host.send(handle, &payload));
    assert_eq!(hits.load(Ordering::Relaxed), 2);
}

/// 바이너리 경로(`send_bytes`)도 동일 계약 — 초과 `false`·무도달, 이하 `true`·도달.
#[test]
fn send_bytes_over_limit_returns_false_and_under_limit_delivers() {
    let _guard = limit_guard();
    let host = ChannelHost::default();
    let seen: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |payload: &[u8]| seen.lock().unwrap().push(payload.to_vec()))
    };
    let handle = host.register_channel_bytes(sink);

    let oversized = vec![0u8; MIB + 1];
    assert!(!host.send_bytes(handle, &oversized));
    assert!(seen.lock().unwrap().is_empty());

    let frame = vec![0xde, 0xad, 0xbe, 0xef];
    assert!(host.send_bytes(handle, &frame));
    let delivered = seen.lock().unwrap();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0], frame);
}

/// 이미 전파되던 JS-facing bool — `rustra_ffi_channel_send` 는 초과 프레임에
/// 0 을 반환한다(RN 호스트가 소비하는 loud 신호). 한도 이하는 기존대로 1.
static FFI_HITS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn counting_sink(
    _user_data: *mut c_void,
    _handle: u32,
    _payload: *const std::ffi::c_char,
) {
    FFI_HITS.fetch_add(1, Ordering::Relaxed);
}

#[test]
fn ffi_channel_send_surfaces_over_limit_as_zero() {
    let _guard = limit_guard();
    let handle = unsafe { rustra_ffi_channel_create(counting_sink, std::ptr::null_mut()) };
    assert_ne!(handle, 0);

    assert_eq!(
        unsafe { rustra_ffi_channel_send(handle, c"{\"ok\":true}".as_ptr()) },
        1
    );
    assert_eq!(FFI_HITS.load(Ordering::Relaxed), 1);

    let oversized = format!("{}\0", "z".repeat(MIB + 1));
    assert_eq!(
        unsafe { rustra_ffi_channel_send(handle, oversized.as_ptr().cast()) },
        0,
        "초과 프레임은 0(실패)으로 보고된다"
    );
    assert_eq!(FFI_HITS.load(Ordering::Relaxed), 1);

    assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 1);
}
