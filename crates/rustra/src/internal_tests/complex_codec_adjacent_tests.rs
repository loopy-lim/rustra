use crate::*;
use std::collections::BTreeMap;

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "t", content = "c")]
enum AdjacentEvent {
    #[schemars(title = "Txt")]
    Txt(String),
    #[schemars(title = "Nums")]
    Nums(BTreeMap<String, i64>),
    #[schemars(title = "Off")]
    Off,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
struct AdjacentInput {
    event: AdjacentEvent,
    tags: Vec<i64>,
}

fn adjacent_codec() -> CompiledComplex {
    let (schema, definitions) = crate::schema_value::<AdjacentInput>();
    CompiledComplex::new(&schema, &definitions)
}

fn input(event: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "event": event, "tags": [] })
}

// 변형 인덱스는 키 "Nums" < "Txt" < "t" 사전순 — Txt/Nums 본체는 태그 enum
// varint 를 포함하는 struct 폴스루, Off 본체는 t 언래핑이다.
#[test]
fn adjacent_tagged_variants_encode_their_own_wire() {
    let codec = adjacent_codec();
    let limits = ComplexCodecLimits::DEFAULT;
    let cases: &[(&str, serde_json::Value, &[u8])] = &[
        (
            "nums",
            input(serde_json::json!({"t": "Nums", "c": {"a": -1}})),
            &[0, 0, 1, 1, b'a', 1, 0],
        ),
        (
            "txt",
            input(serde_json::json!({"t": "Txt", "c": "hi"})),
            &[1, 0, 2, b'h', b'i', 0],
        ),
        ("off", input(serde_json::json!({"t": "Off"})), &[2, 0, 0]),
    ];
    for (name, value, wire) in cases {
        let bytes = codec.encode(value, limits).expect(name);
        assert_eq!(&bytes[..], *wire, "{name}");
        assert_eq!(&codec.decode(&bytes, limits).expect(name), value, "{name}");
    }
}

#[test]
fn adjacent_tagged_non_members_stay_rejected() {
    let codec = adjacent_codec();
    let limits = ComplexCodecLimits::DEFAULT;
    for (name, event) in [
        ("unknown tag", serde_json::json!({"t": "Bogus"})),
        ("missing tag", serde_json::json!({"c": 1})),
        ("not an object", serde_json::json!(3)),
    ] {
        let error = codec.encode(&input(event), limits).expect_err(name);
        assert_eq!(error.code(), "command.invalid_args", "{name}");
    }
}
