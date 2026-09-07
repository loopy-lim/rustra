use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn channel_roundtrip_and_drop() {
    let h = ChannelHost::default();
    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let handle = h.register_channel(Arc::new(move |_p| {
        hits2.fetch_add(1, Ordering::Relaxed);
    }));
    assert_eq!(handle, 1);
    assert!(h.send(handle, "{}"));
    assert_eq!(hits.load(Ordering::Relaxed), 1);
    assert!(h.drop_channel(handle));
    assert!(!h.send(handle, "{}"));
    assert_eq!(hits.load(Ordering::Relaxed), 1);
}

#[test]
fn channel_sender_panic_is_isolated() {
    let h = ChannelHost::default();
    let handle = h.register_channel(Arc::new(|_p| panic!("host callback boom")));
    assert!(h.send(handle, "x"));
}

#[test]
fn resource_lifecycle_and_type_isolation() {
    let h = ChannelHost::default();
    struct Conn {
        id: u32,
    }
    let handle = h.register_resource(Arc::new(Conn { id: 7 }));
    let conn = h.resource::<Conn>(handle).expect("registered");
    assert_eq!(conn.id, 7);
    assert!(h.resource::<String>(handle).is_none());
    assert!(h.drop_resource(handle));
    assert!(h.resource::<Conn>(handle).is_none());
}

#[test]
fn handles_never_reused() {
    let h = ChannelHost::default();
    let a = h.register_channel(Arc::new(|_| {}));
    assert!(h.drop_channel(a));
    let b = h.register_channel(Arc::new(|_| {}));
    assert_ne!(a, b);
}

#[test]
fn exhausted_handle_space_returns_zero_without_reusing_a_live_handle() {
    let h = ChannelHost {
        next_handle: AtomicU64::new(u64::from(u32::MAX)),
        channels: Mutex::new(BTreeMap::new()),
        bytes_channels: Mutex::new(BTreeMap::new()),
        resources: Mutex::new(BTreeMap::new()),
    };
    let last = h.register_channel(Arc::new(|_| {}));
    assert_eq!(last, u32::MAX);
    assert_eq!(h.register_channel(Arc::new(|_| {})), 0);
    assert_eq!(h.register_resource(Arc::new("not inserted")), 0);
    assert_eq!(h.counts(), (1, 0));
    assert!(h.send(last, "still live"));
}

#[test]
fn serde_surface_is_plain_u32() {
    let ch = ChannelHandle(14);
    assert_eq!(serde_json::to_string(&ch).unwrap(), "14");
    let rh: ResourceHandle = serde_json::from_str("3").unwrap();
    assert_eq!(rh.0, 3);
}

/// 바이너리 채널 수명주기 — 발급→send_bytes→drop→stale 무시, JSON 핸들과의
/// 경로 분리(한 핸들은 한 경로로만 동작)를 검증한다.
#[test]
fn channel_bytes_lifecycle_and_path_separation() {
    let host = crate::channels::host();
    let received: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let received = Arc::clone(&received);
        Arc::new(move |payload: &[u8]| {
            received.lock().unwrap().push(payload.to_vec());
        }) as crate::channels::ChannelBytesSender
    };
    let handle = host.register_channel_bytes(sink);
    assert!(handle >= 1);

    // 왕복 — 바이너리 그대로 도달한다(0xFF 계열 프레임 포함).
    assert!(host.send_bytes(handle, &[0xff, 0x00, 0xfe, 0x01]));
    assert!(host.send_bytes(handle, &[]));
    {
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0], vec![0xff, 0x00, 0xfe, 0x01]);
        assert!(received[1].is_empty());
    }

    // 경로 분리 — JSON send 는 bytes 핸들에서 거짓(미등록)으로 끝나고
    // 페이로드도 도달하지 않는다(vice versa 동일).
    assert!(!host.send(handle, "{\"ok\":true}"));
    assert_eq!(
        received.lock().unwrap().len(),
        2,
        "json path must not reach a bytes channel"
    );

    // drop → stale.
    assert!(host.drop_channel(handle));
    assert!(!host.send_bytes(handle, &[1, 2, 3]));
    assert!(!host.drop_channel(handle), "double drop is not a removal");
}

/// `ChannelHandle::send_bytes` — 커맨드 반환 경로에서의 바이너리 전달 표면.
#[test]
fn channel_handle_send_bytes_round_trip() {
    let host = crate::channels::host();
    let seen: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |payload: &[u8]| *seen.lock().unwrap() = payload.to_vec())
            as crate::channels::ChannelBytesSender
    };
    let handle = host.register_channel_bytes(sink);
    let wire = crate::channels::ChannelHandle(handle);
    assert!(wire.send_bytes(b"\xde\xad\xbe\xef"));
    assert_eq!(seen.lock().unwrap().as_slice(), b"\xde\xad\xbe\xef");
    host.drop_channel(handle);
}
