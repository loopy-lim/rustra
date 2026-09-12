use rustra::{Package, State};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize, Serialize, JsonSchema)]
struct Input {
    n: u32,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema, PartialEq)]
struct Output {
    value: u32,
}

struct Database(u32);

#[rustra::command]
fn from_state(input: Input, state: State<Database>) -> rustra::Result<Output> {
    Ok(Output {
        value: input.n + state.0.0,
    })
}

#[test]
fn state_is_available_in_json_frame_direct_and_raw_routes() {
    let package = Package::builder("state-routes")
        .manage(Database(40))
        .command_fn(from_state)
        .build();
    for frozen in [false, true] {
        if frozen {
            package.freeze();
        }
        assert_eq!(
            package
                .invoke_json("fromState", serde_json::json!({"n": 2}))
                .unwrap(),
            serde_json::json!({"value": 42})
        );
        let frame = package.invoke_frame(&[1, 0, 2]).unwrap();
        assert_eq!(
            postcard::from_bytes::<Output>(&frame[8..]).unwrap().value,
            42
        );
        let mut target = [0; 32];
        assert!(matches!(
            package.invoke_frame_into(&[1, 0, 2], &mut target).unwrap(),
            rustra::DirectResponse::Written(9)
        ));
        assert_eq!(target[8], 42);
        assert_eq!(package.invoke_raw(1, &[2]).unwrap(), 42);
    }
}

#[test]
fn nested_package_does_not_inherit_outer_state_and_restores_context() {
    let inner = Package::builder("empty-inner")
        .command_fn(from_state)
        .build();
    let outer = Package::builder("outer")
        .manage(Database(40))
        .command("nested", move |input: Input| {
            let error = inner.invoke_frame(&[1, 0, 2]).unwrap_err();
            assert!(error.to_string().contains("not managed"));
            Ok(Output {
                value: input.n + rustra::state::get_state::<Database>().unwrap().0.0,
            })
        })
        .build();
    assert_eq!(outer.invoke_frame(&[1, 0, 2]).unwrap()[8], 42);
    assert!(rustra::state::get_state::<Database>().is_none());
}

#[test]
fn empty_nested_context_restores_outer_state_after_panic() {
    let mut states = rustra::state::StateMap::new();
    states.insert(std::any::TypeId::of::<Database>(), Arc::new(Database(40)));
    rustra::state::with_state_context(&Arc::new(states), || {
        let saw_empty = std::cell::Cell::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rustra::state::with_state_context(&Arc::default(), || {
                saw_empty.set(rustra::state::get_state::<Database>().is_none());
                panic!("inner panic");
            });
        }));
        assert!(result.is_err());
        assert!(saw_empty.get());
        assert_eq!(rustra::state::get_state::<Database>().unwrap().0.0, 40);
    });
    assert!(rustra::state::get_state::<Database>().is_none());
}

#[test]
fn diagnostic_counts_include_json_bytes_and_resources() {
    let host = rustra::channels::ChannelHost::default();
    let bytes = host.register_channel_bytes(Arc::new(|_| {}));
    assert_eq!(host.counts(), (1, 0));
    let json = host.register_channel(Arc::new(|_| {}));
    let resource = host.register_resource(Arc::new(42));
    assert_eq!(host.counts(), (2, 1));
    assert!(host.drop_channel(bytes));
    assert!(host.drop_channel(json));
    assert!(host.drop_resource(resource));
    assert_eq!(host.counts(), (0, 0));
}
