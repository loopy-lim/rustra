//! 채널 FFI 싱크의 내부 NUL fail-closed 계약 — 채널 유실점 정비(2026-09-20) 후속.
//!
//! 계약: JSON 채널 싱크(`FfiChannelSink::invoke`)는 페이로드에 내부 NUL 이
//! 있으면 CString 변환에 실패한다. NUL 종결 C 문자열 계약상 잘라 보내는 것은
//! 조용한 데이터 오염이므로 프레임을 통째로 드롭하고 eprintln 진단을 남긴다
//! (수정 전에는 로그 없이 소실됐다). sender 클로저 계약이 `Fn(&str)` 라
//! 실패를 되돌려줄 수 없으므로 `ChannelHost::send` 는 이 경우에도 `true` 를
//! 반환한다 — 손실의 관측점은 (1) 콜백 미도달과 (2) 진단 로그다. 이 테스트는
//! (1)을 고정한다: 잘린 접두사도, 원본도 콜백에 도달하지 않는다.
//!
//! 내부 NUL 은 FFI 진입(`rustra_ffi_channel_send`, CStr 파싱)으로는 만들 수
//! 없고 Rust 호스트가 `ChannelHost::send` 로 흘릴 때만 발생한다 — 테스트도
//! 그 경로를 쓴다(channel_send_limit.rs 의 전역 호스트 + 카운터 싱크 패턴).

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicUsize, Ordering};

use rustra::channels::host;
use rustra::ffi::{
    rustra_ffi_channel_create, rustra_ffi_channel_create_bytes, rustra_ffi_channel_drop,
};

/// JSON 채널 콜백 도달 수 — 이 static 을 쓰는 테스트는 이 파일에 하나뿐이라
/// 병렬 테스트 간 카운트 오염이 없다.
static JSON_HITS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn json_sink(_user_data: *mut c_void, _handle: u32, _payload: *const c_char) {
    JSON_HITS.fetch_add(1, Ordering::Relaxed);
}

/// 내부 NUL 프레임은 fail-closed — 잘린 접두사("AB")도 통째 프레임도 콜백에
/// 도달하지 않고, `send` 반환값은 클로저 계약대로 `true` 로 유지된다.
#[test]
fn interior_nul_json_frame_dropped_fail_closed() {
    let handle = unsafe { rustra_ffi_channel_create(json_sink, std::ptr::null_mut()) };
    assert_ne!(handle, 0);
    let host = host();

    // 내부 NUL 프레임 — 드롭되지만 호출 귀속 계약상 true.
    assert!(
        host.send(handle, "AB\0CD"),
        "sender 클로저 계약(Fn(&str))상 send 는 true 를 반환한다 — 손실은 진단 로그로 관측된다"
    );

    // 잠깐의 접두사 전송(트렁케이션 "수정")도 이 어설션을 깬다 — fail-closed 고정.
    assert_eq!(
        JSON_HITS.load(Ordering::Relaxed),
        0,
        "내부 NUL 프레임은 잘리지도, 통과하지도 않는다 — 통째로 드롭된다"
    );

    // 대조 — NUL 없는 프레임은 변경 전과 동일하게 도달한다.
    assert!(host.send(handle, "{\"ok\":true}"));
    assert_eq!(JSON_HITS.load(Ordering::Relaxed), 1);

    assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 1);
}

/// 바이너리 경로는 C 문자열 계약이 없다 — 내부 NUL 바이트도 무손실 도달한다.
/// 게이트가 JSON 채널 경로에만 존재함을 대조로 고정한다.
#[test]
fn bytes_path_delivers_interior_nul_losslessly() {
    static BYTES_SEEN: std::sync::Mutex<Vec<Vec<u8>>> = std::sync::Mutex::new(Vec::new());
    unsafe extern "C" fn bytes_sink(
        _user_data: *mut c_void,
        _handle: u32,
        payload: *const u8,
        payload_len: usize,
    ) {
        // Safety: 콜백 계약 — payload_len 바이트는 반환 전까지 유효하다.
        let slice = unsafe { std::slice::from_raw_parts(payload, payload_len) };
        BYTES_SEEN.lock().unwrap().push(slice.to_vec());
    }

    let handle = unsafe { rustra_ffi_channel_create_bytes(bytes_sink, std::ptr::null_mut()) };
    assert_ne!(handle, 0);

    let frame: &[u8] = b"AB\0CD";
    assert!(host().send_bytes(handle, frame));
    let delivered = BYTES_SEEN.lock().unwrap();
    assert_eq!(delivered.len(), 1);
    assert_eq!(
        delivered[0], frame,
        "바이너리 프레임의 내부 NUL 은 데이터가 아니라 페이로드다 — 무손실 도달"
    );
    drop(delivered);

    assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 1);
}
