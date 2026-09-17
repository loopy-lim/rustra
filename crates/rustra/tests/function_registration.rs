use rustra::{Package, RustraError};
use serde_json::json;

fn add(a: i32, b: i32) -> i32 {
    a + b
}
#[test]
fn ordinary_function_json_and_postcard() {
    let pkg = Package::builder("test.functions")
        .function("add", add)
        .build();
    assert_eq!(pkg.invoke_json("add", json!([2, 3])).unwrap(), json!(5));
    assert_eq!(pkg.live_schema()["commands"][0]["functionArgs"], 2);
    assert_eq!(
        pkg.invoke_frame(&[1, 0, 4, 6]).unwrap(),
        vec![1, 0, 0, 0, 0, 0, 0, 0, 10]
    );
    assert!(pkg.invoke_json("add", json!([2])).is_err());
    assert!(pkg.invoke_json("add", json!([2, 3, 4])).is_err());
}

#[test]
fn arities_closures_and_native_return_shapes() {
    use std::collections::BTreeMap;
    #[derive(serde::Serialize, schemars::JsonSchema)]
    struct Summary {
        value: i32,
    }
    let suffix = String::from("!");
    let pkg = Package::builder("test.shapes")
        .function("zero", || 7)
        .function("one", move |s: String| s + &suffix)
        .function("four", |a: i32, b: i32, c: i32, d: i32| a + b + c + d)
        .function(
            "twelve",
            |a: i32,
             b: i32,
             c: i32,
             d: i32,
             e: i32,
             f: i32,
             g: i32,
             h: i32,
             i: i32,
             j: i32,
             k: i32,
             l: i32| a + b + c + d + e + f + g + h + i + j + k + l,
        )
        .function("nested", |pair: (i32, String)| pair)
        .function("unitArg", |(): ()| 9)
        .function("optional", |value: Option<i32>| value)
        .function("vector", |value: Vec<i32>| value)
        .function("map", || BTreeMap::from([("key", 3)]))
        .function("summary", || Summary { value: 4 })
        .function("dataResult", || Ok::<i32, String>(5))
        .build();
    for (name, args, expected) in [
        ("zero", json!(null), json!(7)),
        ("one", json!(["yes"]), json!("yes!")),
        ("four", json!([1, 2, 3, 4]), json!(10)),
        (
            "twelve",
            json!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
            json!(78),
        ),
        ("nested", json!([[4, "x"]]), json!([4, "x"])),
        ("unitArg", json!([null]), json!(9)),
        ("optional", json!([null]), json!(null)),
        ("optional", json!([3]), json!(3)),
        ("vector", json!([[1, 2, 3]]), json!([1, 2, 3])),
        ("map", json!(null), json!({"key":3})),
        ("summary", json!(null), json!({"value":4})),
        ("dataResult", json!(null), json!({"Ok":5})),
    ] {
        assert_eq!(pkg.invoke_json(name, args).unwrap(), expected, "{name}");
    }
    assert!(pkg.invoke_json("nested", json!([4, "x"])).is_err());
    let schema = pkg.live_schema();
    for (name, arity) in [("zero", 0), ("one", 1), ("four", 4), ("twelve", 12)] {
        assert_eq!(
            schema["commands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == name)
                .unwrap()["functionArgs"],
            arity
        );
    }
    let ts = pkg.generate_typescript().unwrap().commands_ts;
    assert!(ts.contains("arg11:"));
    assert!(ts.contains("[arg0, arg1, arg2, arg3]"));
}

#[test]
fn mapped_errors_capabilities_and_panics_use_existing_guards() {
    struct DomainError(&'static str);
    let pkg = Package::builder("test.guards")
        .try_function(
            "fallible",
            |ok: bool| {
                if ok {
                    Ok(3)
                } else {
                    Err(DomainError("denied"))
                }
            },
            |e| RustraError::custom("domain.denied", e.0),
        )
        .function("secret", || 42)
        .require_capability("secret", "secret.read")
        .function("panic", || -> i32 { panic!("handler panic") })
        .try_function(
            "mapperPanic",
            || Err::<i32, _>(()),
            |_| -> RustraError { panic!("mapper panic") },
        )
        .build();
    assert_eq!(
        pkg.invoke_json("fallible", json!([true])).unwrap(),
        json!(3)
    );
    assert_eq!(
        pkg.invoke_json("fallible", json!([false]))
            .unwrap_err()
            .code(),
        "domain.denied"
    );
    assert!(pkg.invoke_json("secret", json!(null)).is_err());
    pkg.grant_capability("secret.read").unwrap();
    assert_eq!(pkg.invoke_json("secret", json!(null)).unwrap(), json!(42));
    assert!(pkg.invoke_frame(&[3, 0]).is_err());
    assert!(pkg.invoke_frame(&[4, 0]).is_err());
}

#[test]
fn binary_arity_and_unit_buffer_do_not_repeat_side_effects() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let pkg = Package::builder("test.into")
        .function("add", add)
        .function("reset", move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
        .build();
    assert!(pkg.invoke_frame(&[1, 0, 4]).is_err());
    assert!(pkg.invoke_frame(&[1, 0, 4, 6, 8]).is_err());
    assert!(pkg.invoke_frame(&[2, 0, 0]).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut target = [0; 8];
    assert!(matches!(
        pkg.invoke_frame_into(&[2, 0], &mut target).unwrap(),
        rustra::DirectResponse::Written(8)
    ));
    assert_eq!(target, [1, 0, 0, 0, 0, 0, 0, 0]);
    assert!(matches!(
        pkg.invoke_frame_into(&[2, 0], &mut [0; 2]).unwrap(),
        rustra::DirectResponse::Buffered(_)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(pkg.invoke_raw(1, &[2, 3]).is_err());
}

#[test]
#[should_panic(expected = "duplicate command registration")]
fn duplicate_function_names_are_rejected() {
    Package::builder("test.duplicate")
        .function("add", add)
        .function("add", add);
}

#[test]
fn legacy_command_metadata_and_hash_are_unchanged() {
    let command = Package::builder("test.legacy")
        .command("add", |(a, b): (i32, i32)| Ok(a + b))
        .build();
    let function = Package::builder("test.legacy").function("add", add).build();
    assert!(
        command.live_schema()["commands"][0]
            .get("functionArgs")
            .is_none()
    );
    assert_ne!(
        command.generate_typescript().unwrap().contract_hash,
        function.generate_typescript().unwrap().contract_hash
    );
}

#[test]
fn fixed_array_arguments_and_outputs_have_no_length_prefix() {
    let pkg = Package::builder("test.fixed")
        .function("fixed", |values: [i32; 2]| {
            [values[0] + values[1], values[0] - values[1]]
        })
        .function("bytes", |bytes: [u8; 3]| bytes)
        .function("vector", |values: Vec<i32>| values)
        .build();
    assert_eq!(
        pkg.invoke_frame(&[1, 0, 16, 6]).unwrap(),
        [1, 0, 0, 0, 0, 0, 0, 0, 22, 10]
    );
    assert_eq!(
        pkg.invoke_frame(&[2, 0, 0, 128, 255]).unwrap(),
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 128, 255]
    );
    assert_eq!(
        pkg.invoke_frame(&[3, 0, 2, 16, 6]).unwrap(),
        [1, 0, 0, 0, 0, 0, 0, 0, 2, 16, 6]
    );
}

#[test]
fn closed_legacy_struct_keeps_postcard_tuple_wire() {
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct ClosedInput {
        pair: (i32, i32),
    }
    #[derive(serde::Serialize, schemars::JsonSchema)]
    #[serde(deny_unknown_fields)]
    struct ClosedOutput {
        pair: (i32, i32),
    }
    let package = Package::builder("test.closed")
        .command("closed", |input: ClosedInput| {
            Ok(ClosedOutput {
                pair: (input.pair.0 + input.pair.1, input.pair.0 - input.pair.1),
            })
        })
        .build();
    let response = package.invoke_frame(&[1, 0, 16, 6]).unwrap();
    assert_eq!(response, [1, 0, 0, 0, 0, 0, 0, 0, 22, 10]);
    let mut target = [0; 10];
    assert!(matches!(
        package
            .invoke_frame_into(&[1, 0, 16, 6], &mut target)
            .unwrap(),
        rustra::DirectResponse::Written(10)
    ));
    assert_eq!(target.as_slice(), response);
}

#[test]
fn nested_optional_and_vector_refs_keep_postcard_route() {
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct Leaf {
        n: i32,
    }
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct Middle {
        child: Option<Leaf>,
    }
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct Outer {
        child: Option<Middle>,
    }
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct MiddleVec {
        child: Vec<Leaf>,
    }
    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct OuterVec {
        child: Vec<MiddleVec>,
    }
    let package = Package::builder("test.depth")
        .function("optional", |value: Outer| {
            value.child.unwrap().child.unwrap().n
        })
        .function("vector", |value: OuterVec| value.child[0].child[0].n)
        .build();
    for id in [1, 2] {
        assert_eq!(
            package.invoke_frame(&[id, 0, 1, 1, 6]).unwrap(),
            [1, 0, 0, 0, 0, 0, 0, 0, 6]
        );
    }
}

#[test]
fn int8_function_arguments_and_return_values_use_raw_bytes() {
    let package = Package::builder("test.int8")
        .function("echo", |value: i8| value)
        .build();
    for byte in [128, 255, 0, 1, 127] {
        assert_eq!(
            package.invoke_frame(&[1, 0, byte]).unwrap(),
            [1, 0, 0, 0, 0, 0, 0, 0, byte]
        );
    }
}

#[test]
fn legacy_root_object_preserves_field_depth_zero_budget() {
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct Input {
        child: L1,
        pair: (i32, i32),
    }
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct L1 {
        child: L2,
    }
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct L2 {
        child: L3,
    }
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct L3 {
        child: L4,
    }
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    struct L4 {
        n: i32,
    }
    let package = Package::builder("test.legacy-depth")
        .command("deep", |input: Input| Ok(input))
        .function("nested", |input: Input| input)
        .build();
    let request = [1, 0, 6, 8, 10];
    let expected = [1, 0, 0, 0, 0, 0, 0, 0, 6, 8, 10];
    assert_eq!(package.invoke_frame(&request).unwrap(), expected);
    let mut target = [0; 11];
    assert!(matches!(
        package.invoke_frame_into(&request, &mut target).unwrap(),
        rustra::DirectResponse::Written(11)
    ));
    assert_eq!(target, expected);
    // A struct nested in a function's argument tuple is not another root.
    assert!(package.invoke_frame(&[2, 0, 6, 8, 10]).is_err());
}
