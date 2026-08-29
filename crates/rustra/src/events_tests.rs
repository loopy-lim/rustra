use super::*;

#[test]
fn emit_and_take_roundtrip() {
    let bus = EventBus::new();
    bus.emit("progress.tick", r#"{"value":42}"#);
    bus.emit("progress.done", "{}");
    let events = bus.take_pending_events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].name, "progress.tick");
    assert_eq!(events[0].payload, r#"{"value":42}"#);
    assert_eq!(events[0].seq, 0);
    assert_eq!(events[1].seq, 1);
    assert_eq!(bus.pending_len(), 0);
}

#[test]
fn drop_oldest_on_overflow() {
    let bus = EventBus::with_capacity(2);
    bus.emit("a", "1");
    bus.emit("b", "2");
    bus.emit("c", "3");
    let events = bus.take_pending_events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].name, "b");
    assert_eq!(bus.dropped_count(), 1);
}

#[test]
fn seq_is_monotonic_across_takes() {
    let bus = EventBus::new();
    bus.emit("a", "1");
    let _ = bus.take_pending_events();
    bus.emit("b", "2");
    assert_eq!(bus.take_pending_events()[0].seq, 1);
}

#[test]
fn shared_clone_sees_same_queue() {
    let bus = EventBus::new();
    let clone = bus.clone();
    clone.emit("x", "1");
    assert_eq!(bus.pending_len(), 1);
}

type Recorded = Arc<Mutex<Vec<(String, String)>>>;

fn recording_sink(seen: Recorded) -> (Recorded, EventSink) {
    let sink_seen = Arc::clone(&seen);
    let sink: EventSink = Arc::new(move |name, payload| {
        sink_seen
            .lock()
            .unwrap()
            .push((name.to_string(), payload.to_string()));
    });
    (seen, sink)
}

#[test]
fn sink_receives_event_and_bus_stays_empty() {
    let state = EventState::new();
    let (seen, sink) = recording_sink(Arc::new(Mutex::new(Vec::new())));
    state.sink.write().unwrap().replace(sink);
    assert!(state.deliver_via_sink("progress.tick", r#"{"value":1}"#));
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(state.bus.take_pending_events().len(), 0);
}

#[test]
fn no_sink_falls_back_to_bus() {
    let state = EventState::new();
    assert!(!state.deliver_via_sink("a", "1"));
    state.bus.emit("a", "1");
    assert_eq!(state.bus.take_pending_events().len(), 1);
}

#[test]
fn clearing_sink_restores_bus_path() {
    let state = EventState::new();
    let (_, sink) = recording_sink(Arc::new(Mutex::new(Vec::new())));
    state.sink.write().unwrap().replace(sink);
    assert!(state.deliver_via_sink("a", "1"));
    state.sink.write().unwrap().take();
    assert!(!state.deliver_via_sink("b", "2"));
}

#[test]
fn panicking_sink_does_not_propagate() {
    let state = EventState::new();
    state
        .sink
        .write()
        .unwrap()
        .replace(Arc::new(|_, _| panic!("host sink exploded")));
    assert!(state.deliver_via_sink("boom", "1"));
    assert!(state.deliver_via_sink("boom", "2"));
}

#[test]
fn sequential_sink_calls_preserve_order() {
    let state = EventState::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (_, sink) = recording_sink(Arc::clone(&seen));
    state.sink.write().unwrap().replace(sink);
    for i in 0..5 {
        state.deliver_via_sink("tick", &format!("{{\"i\":{i}}}"));
    }
    let values: Vec<i64> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(_, p)| {
            serde_json::from_str::<serde_json::Value>(p).unwrap()["i"]
                .as_i64()
                .unwrap()
        })
        .collect();
    assert_eq!(values, vec![0, 1, 2, 3, 4]);
}

#[test]
fn bus_drop_oldest_unaffected_by_sink_code() {
    let bus = EventBus::with_capacity(2);
    bus.emit("a", "1");
    bus.emit("b", "2");
    bus.emit("c", "3");
    let events = bus.take_pending_events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].name, "b");
    assert_eq!(bus.dropped_count(), 1);
}
