use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// A fixed tuple uses the generic child Deserializer. Compare it with the
// homogeneous path using the same bytes, element types and depth limits.
fn compare<T: de::DeserializeOwned + Serialize>(
    unsigned: bool,
    length: usize,
    bytes: &[u8],
    limits: ComplexCodecLimits,
) -> Result<Value> {
    let item = if unsigned {
        json!({"type":"integer","format":"uint64"})
    } else {
        json!({"type":"integer"})
    };
    let homogeneous =
        super::super::complex_schema_ir::compile(&json!({"type":"array","items":item}), &json!({}))
            .unwrap();
    let tuple = super::super::complex_schema_ir::compile(
        &json!({"type":"array","items":vec![item; length]}),
        &json!({}),
    )
    .unwrap();
    let decode = |ir: &IrNode| {
        from_bytes::<Vec<T>>(bytes, ir, limits).map(|value| serde_json::to_value(value).unwrap())
    };
    let actual = decode(&homogeneous);
    assert_eq!(actual, decode(&tuple));
    actual
}

#[test]
fn integer_sequences_match_generic_children_at_wire_and_visitor_boundaries() {
    let limits = ComplexCodecLimits::DEFAULT;
    assert_eq!(
        compare::<i64>(false, 2, &[2, 1, 254, 1], limits).unwrap(),
        json!([-1, 127])
    );
    assert!(compare::<i8>(false, 1, &[1, 128, 2], limits).is_err());
    assert!(compare::<u8>(false, 1, &[1, 1], limits).is_err());
    let mut largest = vec![1];
    largest.extend_from_slice(&[255; 9]);
    largest.push(1);
    assert_eq!(
        compare::<u64>(true, 1, &largest, limits).unwrap(),
        json!([u64::MAX])
    );
    assert!(compare::<i64>(true, 1, &largest, limits).is_err());
    assert_eq!(
        compare::<u128>(true, 1, &largest, limits).unwrap(),
        json!([u64::MAX])
    );
    for malformed in [vec![1], vec![1, 128], vec![1, 0, 0], {
        let mut bytes = vec![1];
        bytes.extend_from_slice(&[255; 10]);
        bytes
    }] {
        assert!(compare::<i64>(false, 1, &malformed, limits).is_err());
    }
    #[derive(Serialize, Deserialize)]
    struct Number(i64);
    assert_eq!(
        compare::<Number>(false, 1, &[1, 42], limits).unwrap(),
        json!([21])
    );
    // deserialize_any must keep its old schema-driven rejection, rather than
    // being widened by serde's generic I64Deserializer adapter.
    assert!(compare::<Value>(false, 1, &[1, 42], limits).is_err());
    assert!(compare::<String>(false, 1, &[1, 42], limits).is_err());
}

#[test]
fn integer_sequence_fast_path_keeps_lazy_depth_and_custom_entry_behavior() {
    let limits = ComplexCodecLimits {
        max_depth: 0,
        ..ComplexCodecLimits::DEFAULT
    };
    assert_eq!(compare::<i64>(false, 0, &[0], limits).unwrap(), json!([]));
    assert!(compare::<i64>(false, 1, &[1, 0], limits).is_err());
    #[derive(Serialize)]
    struct NoRead;
    impl<'de> Deserialize<'de> for NoRead {
        fn deserialize<D: Deserializer<'de>>(_: D) -> std::result::Result<Self, D::Error> {
            Ok(Self)
        }
    }
    // A custom element that never enters the Deserializer must not trigger an
    // early child depth check or consume a varint before its seed is called.
    assert_eq!(
        compare::<NoRead>(false, 1, &[1], limits).unwrap(),
        json!([null])
    );
    assert_eq!(
        compare::<NoRead>(false, 1, &[1], ComplexCodecLimits::DEFAULT).unwrap(),
        json!([null])
    );
}
