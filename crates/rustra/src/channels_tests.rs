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
