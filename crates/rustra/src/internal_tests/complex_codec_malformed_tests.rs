use crate::*;
use std::collections::BTreeMap;

// Value 경로(adjacent tagged — Node 본체 → 직결 게이트 미달)와 직결 경로(외부
// tagged oneOf — UnwrapSingle) 픽스처. 두 라우트 모두 complex 바이너리 경로다
// (oneOf 필드 → postcard 코덱 미지원).
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "t", content = "c")]
enum GateEvent {
    #[schemars(title = "Txt")]
    Txt(String),
    #[schemars(title = "Nums")]
    Nums(BTreeMap<String, i64>),
    #[schemars(title = "Off")]
    Off,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
struct GateInput {
    event: GateEvent,
    tags: Vec<i64>,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
enum RoutedStatus {
    Active { level: i64 },
    Idle,
}

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
struct StatusInput {
    status: RoutedStatus,
    note: Option<String>,
}

#[derive(Debug, PartialEq, serde::Deserialize, schemars::JsonSchema)]
struct MismatchInput {
    count: i64,
}

// 변형 인덱스는 variant key 사전순 순번이다 — "Nums", "Txt"(title), 그리고
// 단일 프로퍼티 변형(Off)은 프로퍼티명 "t" 가 키다.
fn gate_codec() -> CompiledComplex {
    let (schema, definitions) = crate::schema_value::<GateInput>();
    CompiledComplex::new(&schema, &definitions)
}

fn status_codec() -> CompiledComplex {
    let (schema, definitions) = crate::schema_value::<StatusInput>();
    CompiledComplex::new(&schema, &definitions)
}

fn gate_limits() -> ComplexCodecLimits {
    ComplexCodecLimits {
        max_payload_bytes: 4096,
        ..ComplexCodecLimits::DEFAULT
    }
}

#[test]
fn fixtures_split_value_and_serde_direct_routes() {
    let (gate_schema, gate_defs) = crate::schema_value::<GateInput>();
    let (status_schema, status_defs) = crate::schema_value::<StatusInput>();
    assert!(crate::complex_schema_supported(&gate_schema, &gate_defs));
    assert!(crate::complex_schema_supported(
        &status_schema,
        &status_defs
    ));
    assert!(
        !gate_codec().serde_direct(),
        "Node 본체 픽스처는 Value 경로여야 한다"
    );
    assert!(
        status_codec().serde_direct(),
        "UnwrapSingle 픽스처는 직결 경로여야 한다"
    );
}

#[test]
fn value_path_rejects_structurally_broken_payloads() {
    let codec = gate_codec();
    let limits = gate_limits();
    let broken: &[(&str, &[u8], &str)] = &[
        ("empty", &[], "complex codec: truncated complex payload"),
        (
            "trailing byte",
            &[2, 0, 1, 10, 0],
            "complex codec: trailing bytes in complex payload",
        ),
        (
            "truncated mid struct",
            &[0, 0],
            "complex codec: truncated complex payload",
        ),
        (
            "string length beyond payload",
            &[1, 0, 127],
            "complex codec: truncated complex payload",
        ),
        (
            "varint cut at payload end",
            &[1, 0, 255],
            "complex codec: truncated complex payload",
        ),
        (
            "map key is not utf-8",
            &[0, 0, 1, 1, 0xFF, 1, 0],
            "complex codec: invalid UTF-8 string",
        ),
    ];
    for (name, bytes, message) in broken {
        let error = codec.decode(bytes, limits).expect_err(name);
        assert_eq!(error.code(), "command.invalid_args", "{name}");
        assert_eq!(error.message(), *message, "{name}");
    }
}

#[test]
fn value_path_rejects_corrupt_tags_and_indices() {
    let codec = gate_codec();
    let limits = gate_limits();
    let broken: &[(&str, &[u8], &str)] = &[
        (
            "variant index out of range",
            &[7, 1, 10],
            "complex codec: enum variant index out of range",
        ),
        (
            "varint exceeds 64 bits",
            &[255; 10],
            "complex codec: varint exceeds 64 bits",
        ),
        (
            "varint is too long",
            &[0x80; 10],
            "complex codec: varint is too long",
        ),
        (
            "collection length beyond limit",
            &[2, 0, 0xA1, 0x8D, 0x06],
            "complex codec: collection length exceeds 100000",
        ),
    ];
    for (name, bytes, message) in broken {
        let error = codec.decode(bytes, limits).expect_err(name);
        assert_eq!(error.code(), "command.invalid_args", "{name}");
        assert_eq!(error.message(), *message, "{name}");
    }

    let flag_schema = serde_json::json!({"type":"object","properties":{
        "flag": {"type":"boolean"},
        "color": {"type":"string","enum":["red","green"]},
        "note": {"type":["string","null"]}
    }, "required":["flag","color"]});
    let flag_codec = CompiledComplex::new(&flag_schema, &serde_json::json!({}));
    let broken: &[(&str, &[u8], &str)] = &[
        (
            "boolean value",
            &[2, 0],
            "complex codec: invalid boolean value",
        ),
        (
            "plain enum index",
            &[0, 5],
            "complex codec: enum index out of range",
        ),
        (
            "optional presence tag",
            &[0, 0, 2],
            "complex codec: invalid optional field presence tag",
        ),
    ];
    for (name, bytes, message) in broken {
        let error = flag_codec
            .decode(bytes, ComplexCodecLimits::DEFAULT)
            .expect_err(name);
        assert_eq!(error.code(), "command.invalid_args", "{name}");
        assert_eq!(error.message(), *message, "{name}");
    }
}

#[test]
fn value_path_enforces_recursion_depth_limit() {
    let schema = serde_json::json!({"$ref":"#/definitions/Node"});
    let definitions = serde_json::json!({"Node": {"type":"object","properties":{
        "value": {"type":"integer","format":"int64"},
        "next": {"anyOf":[{"$ref":"#/definitions/Node"},{"type":"null"}]}
    },"required":["value","next"]}});
    let codec = CompiledComplex::new(&schema, &definitions);
    let value = serde_json::json!({"value":1,"next":{"value":2,"next":{"value":3,"next":null}}});
    let bytes = codec.encode(&value, gate_limits()).expect("encode");
    let limits = ComplexCodecLimits {
        max_depth: 2,
        ..gate_limits()
    };
    let error = codec.decode(&bytes, limits).expect_err("depth");
    assert_eq!(error.code(), "command.invalid_args");
    assert_eq!(error.message(), "complex codec: value depth exceeds 2");
    assert_eq!(codec.decode(&bytes, gate_limits()).expect("decode"), value);
}

#[test]
fn value_path_bit_flip_sweep_never_panics() {
    let codec = gate_codec();
    let limits = gate_limits();
    let value = serde_json::json!({
        "event": {"t":"Nums","c":{"a":1,"b":-2}},
        "tags": [5, -6]
    });
    let valid = codec.encode(&value, limits).expect("encode");
    assert_eq!(codec.decode(&valid, limits).expect("decode"), value);
    for position in 0..valid.len() {
        for mask in [0x01u8, 0x80, 0xFF] {
            let mut corrupt = valid.clone();
            corrupt[position] ^= mask;
            // 불변식: 패닉/무한 루프 없이 Ok(다른 유효 값) 또는 Err.
            let _ = codec.decode(&corrupt, limits);
        }
    }
}

#[test]
fn direct_path_rejects_structurally_broken_payloads() {
    let codec = status_codec();
    let limits = gate_limits();
    let broken: &[(&str, &[u8], &str)] = &[
        ("empty", &[], "complex codec: truncated complex payload"),
        (
            "variant index out of range",
            &[2],
            "complex codec: enum variant index out of range",
        ),
        (
            "truncated level",
            &[0],
            "complex codec: truncated complex payload",
        ),
        (
            "presence tag",
            &[1, 2],
            "complex codec: invalid optional field presence tag",
        ),
        (
            "trailing byte",
            &[0, 18, 1, 1, 2, 104, 105, 0],
            "complex codec: trailing bytes in complex payload",
        ),
        (
            "varint is too long",
            &[
                0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
            ],
            "complex codec: varint is too long",
        ),
    ];
    for (name, bytes, message) in broken {
        let error = codec
            .decode_direct::<StatusInput>(bytes, limits)
            .expect_err(name);
        assert_eq!(error.code(), "command.invalid_args", "{name}");
        assert_eq!(error.message(), *message, "{name}");
    }
}

#[test]
fn direct_path_rejects_schema_type_mismatch() {
    let codec = status_codec();
    let error = codec
        .decode_direct::<MismatchInput>(&[1, 0], gate_limits())
        .expect_err("type mismatch");
    assert_eq!(error.code(), "command.invalid_args");
    let decoded: StatusInput = codec
        .decode_direct(&[1, 0], gate_limits())
        .expect("valid wire");
    assert_eq!(
        decoded,
        StatusInput {
            status: RoutedStatus::Idle,
            note: None,
        }
    );
}

#[test]
fn direct_path_bit_flip_sweep_never_panics() {
    let codec = status_codec();
    let limits = gate_limits();
    let valid = [0u8, 18, 1, 1, 2, 104, 105];
    let _: StatusInput = codec.decode_direct(&valid, limits).expect("decode");
    for position in 0..valid.len() {
        for mask in [0x01u8, 0x80, 0xFF] {
            let mut corrupt = valid;
            corrupt[position] ^= mask;
            let _ = codec.decode_direct::<StatusInput>(&corrupt, limits);
        }
    }
}

fn malformed_pkg() -> Package {
    fn gate_echo(input: GateInput) -> Result<GateInput> {
        Ok(input)
    }
    fn status_echo(input: StatusInput) -> Result<StatusInput> {
        Ok(input)
    }
    Package::builder("test.complex-malformed")
        .command("gateEcho", gate_echo)
        .command("statusEcho", status_echo)
        .build()
}

fn gate_frame(body: &[u8]) -> Vec<u8> {
    let mut frame = 1u16.to_le_bytes().to_vec();
    frame.extend_from_slice(body);
    frame
}

fn status_frame(body: &[u8]) -> Vec<u8> {
    let mut frame = 2u16.to_le_bytes().to_vec();
    frame.extend_from_slice(body);
    frame
}

#[test]
fn frame_round_trips_both_complex_routes() {
    let pkg = malformed_pkg();
    let gate_response = pkg
        .invoke_frame(&gate_frame(&[0, 0, 1, 1, 97, 1, 0]))
        .expect("gate");
    assert_eq!(gate_response[0], 1, "ok flag");
    assert_eq!(&gate_response[8..], &[0, 0, 1, 1, 97, 1, 0]);
    let status_response = pkg
        .invoke_frame(&status_frame(&[0, 18, 1, 1, 2, 104, 105]))
        .expect("status");
    assert_eq!(status_response[0], 1, "ok flag");
    assert_eq!(&status_response[8..], &[0, 18, 1, 1, 2, 104, 105]);
}

#[test]
fn frame_rejects_short_unknown_and_corrupt_requests() {
    let pkg = malformed_pkg();
    for frame in [&[][..], &[7][..]] {
        let error = pkg.invoke_frame(frame).expect_err("short frame");
        assert_eq!(error.code(), "command.invalid_args");
        assert_eq!(error.message(), "frame: payload too short");
    }
    let error = pkg.invoke_frame(&[0xFF, 0xFF]).expect_err("unknown id");
    assert_eq!(error.code(), "command.not_found");
    let corrupt = pkg
        .invoke_frame(&gate_frame(&[7, 1, 10]))
        .expect_err("gate");
    assert_eq!(corrupt.code(), "command.invalid_args");
    assert_eq!(
        corrupt.message(),
        "complex codec: enum variant index out of range"
    );
    let corrupt = pkg.invoke_frame(&status_frame(&[2])).expect_err("status");
    assert_eq!(
        corrupt.message(),
        "complex codec: enum variant index out of range"
    );
}

#[test]
fn frame_bit_flip_sweep_never_trips_panic_guard() {
    let pkg = malformed_pkg();
    let valid = gate_frame(&[0, 0, 1, 1, 97, 1, 1, 10]);
    assert!(pkg.invoke_frame(&valid).is_ok());
    let mut target = [0u8; 64];
    for position in 0..valid.len() {
        for mask in [0x01u8, 0x80, 0xFF] {
            let mut corrupt = valid.clone();
            corrupt[position] ^= mask;
            // catch_unwind 가드가 패닉을 internal("panic in handler: …") 로
            // 정규화한다 — 무작위 바이트가 이 코드를 유발하면 디코더 버그다.
            let buffered = pkg.invoke_frame(&corrupt);
            if let Err(error) = &buffered {
                assert!(
                    !error.message().starts_with("panic in handler"),
                    "value path panicked on {corrupt:?}: {error}"
                );
            }
            let direct = pkg.invoke_frame_into(&corrupt, &mut target);
            if let Err(error) = &direct {
                assert!(
                    !error.message().starts_with("panic in handler"),
                    "into path panicked on {corrupt:?}: {error}"
                );
            }
        }
    }
}
