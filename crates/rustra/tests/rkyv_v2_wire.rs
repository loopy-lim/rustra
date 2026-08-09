//! rkyv V2 wire path 종합 테스트 — dynamic import(Tier 3) + 정적(postcard) 경로.
//!
//! 도달 가능한 두 wire 를 다양한 타입으로 검증:
//! - 정적(postcard fast-path): `[cmd_id u16][postcard(I)]` → `[ok u8][postcard(O)@8]`
//! - 동적(Tier 3 JSON):        `[cmd_id u16][json]`         → `[ok u8][pad3][json_len u32@4][json@8]`
//!
//! `register`(동적 명령)는 debug 빌드에서만 동작(release=frozen). 정적 테스트는 양쪽 모두.

#![allow(clippy::float_cmp)]

use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[path = "../benches/common.rs"]
mod common;

// ── 공통 핸들러/타입 (dynamic Tier 3 전용 추가 타입) ────────

// Map (string key — JSON 호환)
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MapIn {
    scores: BTreeMap<String, i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MapOut {
    total: i64,
    count: i64,
}
fn map_cmd(input: MapIn) -> rustra::Result<MapOut> {
    Ok(MapOut {
        total: input.scores.values().sum(),
        count: input.scores.len() as i64,
    })
}

// Tuple 필드
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TupleIn {
    pair: (i64, String),
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TupleOut {
    first: i64,
    second: String,
}
fn tuple_cmd(input: TupleIn) -> rustra::Result<TupleOut> {
    Ok(TupleOut {
        first: input.pair.0,
        second: input.pair.1,
    })
}

// Enum with data
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Status {
    Active { level: i64 },
    Idle,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct EnumIn {
    status: Status,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct EnumOut {
    label: String,
}
fn enum_cmd(input: EnumIn) -> rustra::Result<EnumOut> {
    let label = match input.status {
        Status::Active { level } => format!("active:{level}"),
        Status::Idle => "idle".to_string(),
    };
    Ok(EnumOut { label })
}

// Option 필드 (required 아니므로 Tier 3 분류)
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OptIn {
    maybe: Option<i64>,
    name: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OptOut {
    has_value: bool,
}
fn opt_cmd(input: OptIn) -> rustra::Result<OptOut> {
    Ok(OptOut {
        has_value: input.maybe.is_some(),
    })
}

// 중첩 구조체 + Vec<중첩>
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
struct Inner {
    x: i64,
    y: f64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NestedIn {
    inner: Inner,
    list: Vec<Inner>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NestedOut {
    sum_x: i64,
    count: i64,
}
fn nested_cmd(input: NestedIn) -> rustra::Result<NestedOut> {
    let mut sum_x = input.inner.x;
    let mut count = 1i64;
    for it in &input.list {
        sum_x += it.x;
        count += 1;
    }
    Ok(NestedOut { sum_x, count })
}

// Vec<u8> (바이너리) — static Tier 2
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BytesIn {
    data: Vec<u8>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BytesOut {
    len: i64,
    checksum: i64,
}
fn bytes_cmd(input: BytesIn) -> rustra::Result<BytesOut> {
    Ok(BytesOut {
        len: input.data.len() as i64,
        checksum: input.data.iter().map(|&b| b as i64).sum(),
    })
}

// Vec<bool>, Vec<f64>, Vec<i32> — static Tier 2
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
struct MixedVecIn {
    bools: Vec<bool>,
    floats: Vec<f64>,
    ints32: Vec<i32>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MixedVecOut {
    bool_count: i64,
    float_sum: f64,
    int32_sum: i64,
}
fn mixed_vec_cmd(input: MixedVecIn) -> rustra::Result<MixedVecOut> {
    Ok(MixedVecOut {
        bool_count: input.bools.iter().filter(|b| **b).count() as i64,
        float_sum: input.floats.iter().sum(),
        int32_sum: input.ints32.iter().map(|&v| v as i64).sum(),
    })
}

// Tier 1 다양한 primitive 혼합 (정렬 검증 포함)
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
struct PrimIn {
    flag: bool, // 1B
    small: i32, // 4B
    big: i64,   // 8B
    score: f64, // 8B
    code: i16,  // serde 기본 int → wire i32? schemars format 확인 필요
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PrimOut {
    flag: bool,
    big: i64,
    score: f64,
}
fn prim_cmd(input: PrimIn) -> rustra::Result<PrimOut> {
    Ok(PrimOut {
        flag: input.flag,
        big: input.big,
        score: input.score,
    })
}

// ── 헬퍼 ───────────────────────────────────────────────────

/// 정적 postcard 경로 호출 헬퍼.
fn static_invoke<I: Serialize, O: serde::de::DeserializeOwned>(
    pkg: &Package,
    name: &str,
    input: &I,
) -> O {
    let id = common::command_id_of(pkg, name);
    let req = common::postcard_request(id, input);
    let resp = pkg.invoke_rkyv_v2(&req).expect("static invoke ok");
    common::decode_postcard_response::<O>(&resp)
}

/// 동적 Tier 3(JSON) 경로 호출 헬퍼.
#[cfg(debug_assertions)]
fn dyn_invoke<I: Serialize, O: serde::de::DeserializeOwned>(
    pkg: &Package,
    name: &str,
    input: &I,
) -> O {
    let id = common::command_id_of(pkg, name);
    let json = serde_json::to_string(input).expect("serialize dyn input");
    let req = common::tier3_request(id, &json);
    let resp = pkg.invoke_rkyv_v2(&req).expect("dyn invoke ok");
    let val: Value = common::decode_tier3_response(&resp);
    serde_json::from_value(val).expect("deserialize dyn output")
}

// ════════════════════════════════════════════════════════════
// 1. 정적 Tier 1 (postcard fast-path)
// ════════════════════════════════════════════════════════════

#[test]
fn static_tier1_add_round_trip() {
    let pkg = Package::builder("wire.t1.add")
        .command("add", common::add)
        .build();
    let out: common::AddOutput = static_invoke(&pkg, "add", &common::AddInput { a: 40, b: 2 });
    assert_eq!(out.value, 42);
}

#[test]
fn static_tier1_mixed_primitives_round_trip() {
    let pkg = Package::builder("wire.t1.prim")
        .command("prim", prim_cmd)
        .build();
    let out: PrimOut = static_invoke(
        &pkg,
        "prim",
        &PrimIn {
            flag: true,
            small: 1000,
            big: -5,
            score: 3.5,
            code: 7,
        },
    );
    assert!(out.flag);
    assert_eq!(out.big, -5);
    assert_eq!(out.score, 3.5);
}

#[test]
fn static_tier1_negative_and_large_i64() {
    let pkg = Package::builder("wire.t1.range")
        .command("add", common::add)
        .build();
    let cases = [i64::MIN, -1, 0, i64::MAX];
    for v in cases {
        let out: common::AddOutput = static_invoke(&pkg, "add", &common::AddInput { a: v, b: 0 });
        assert_eq!(out.value, v, "i64 round-trip failed for {v}");
    }
}

// ════════════════════════════════════════════════════════════
// 2. 정적 Tier 2 (postcard — String / Vec<primitive>)
// ════════════════════════════════════════════════════════════

#[test]
fn static_tier2_string_round_trip() {
    let pkg = Package::builder("wire.t2.str")
        .command("greet", common::greet)
        .build();
    let out: common::GreetOutput = static_invoke(
        &pkg,
        "greet",
        &common::GreetInput {
            name: "rust".into(),
        },
    );
    assert_eq!(out.message, "hello rust");
}

#[test]
fn static_tier2_vec_i64_round_trip() {
    let pkg = Package::builder("wire.t2.vec")
        .command("sumList", common::sum_list)
        .build();
    let out: common::SumListOutput = static_invoke(
        &pkg,
        "sumList",
        &common::SumListInput {
            numbers: vec![10, 20, 30, 40],
        },
    );
    assert_eq!(out.sum, 100);
    assert_eq!(out.count, 4);
}

#[test]
fn static_tier2_bytes_and_mixed_vecs_round_trip() {
    let pkg = Package::builder("wire.t2.bytes")
        .command("bytes", bytes_cmd)
        .command("mixed", mixed_vec_cmd)
        .build();
    let out: BytesOut = static_invoke(
        &pkg,
        "bytes",
        &BytesIn {
            data: vec![1, 2, 3, 250, 255],
        },
    );
    assert_eq!(out.len, 5);
    assert_eq!(out.checksum, 511);

    let out: MixedVecOut = static_invoke(
        &pkg,
        "mixed",
        &MixedVecIn {
            bools: vec![true, false, true],
            floats: vec![1.5, 2.5],
            ints32: vec![100, 200, 300],
        },
    );
    assert_eq!(out.bool_count, 2);
    assert_eq!(out.float_sum, 4.0);
    assert_eq!(out.int32_sum, 600);
}

#[test]
fn static_tier2_large_payload_round_trip() {
    let pkg = Package::builder("wire.t2.large")
        .command("processPayload", common::process_payload)
        .build();
    let out: common::PayloadOutput = static_invoke(
        &pkg,
        "processPayload",
        &common::PayloadInput {
            items: common::make_items(10_000),
        },
    );
    assert_eq!(out.count, 10_000);
    assert!(out.total_score > 0.0);
}

// ════════════════════════════════════════════════════════════
// 3. 동적 Tier 3 (런타임 register, JSON-in-binary)
// ════════════════════════════════════════════════════════════

#[cfg(debug_assertions)]
fn dyn_pkg() -> Package {
    let pkg = Package::builder("wire.dyn").build();
    pkg.register("echo", common::echo).unwrap();
    pkg.register("add", common::add).unwrap();
    pkg.register("greet", common::greet).unwrap();
    pkg.register("sumList", common::sum_list).unwrap();
    pkg.register("map", map_cmd).unwrap();
    pkg.register("tuple", tuple_cmd).unwrap();
    pkg.register("enum", enum_cmd).unwrap();
    pkg.register("opt", opt_cmd).unwrap();
    pkg.register("nested", nested_cmd).unwrap();
    pkg.register("processPayload", common::process_payload)
        .unwrap();
    pkg
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_primitive_round_trip() {
    let pkg = dyn_pkg();
    let out: common::EchoOutput = dyn_invoke(&pkg, "echo", &common::EchoInput { v: 7 });
    assert_eq!(out.v, 7);
    let out: common::AddOutput = dyn_invoke(&pkg, "add", &common::AddInput { a: 5, b: 37 });
    assert_eq!(out.value, 42);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_string_and_vec_round_trip() {
    let pkg = dyn_pkg();
    // String
    let out: common::GreetOutput =
        dyn_invoke(&pkg, "greet", &common::GreetInput { name: "dyn".into() });
    assert_eq!(out.message, "hello dyn");
    // Vec<i64>
    let out: common::SumListOutput = dyn_invoke(
        &pkg,
        "sumList",
        &common::SumListInput {
            numbers: vec![1, 2, 3],
        },
    );
    assert_eq!(out.sum, 6);
    assert_eq!(out.count, 3);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_map_round_trip() {
    let pkg = dyn_pkg();
    let mut scores = BTreeMap::new();
    scores.insert("a".into(), 10);
    scores.insert("b".into(), 32);
    let out: MapOut = dyn_invoke(&pkg, "map", &MapIn { scores });
    assert_eq!(out.total, 42);
    assert_eq!(out.count, 2);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_tuple_round_trip() {
    let pkg = dyn_pkg();
    let out: TupleOut = dyn_invoke(
        &pkg,
        "tuple",
        &TupleIn {
            pair: (42, "hi".into()),
        },
    );
    assert_eq!(out.first, 42);
    assert_eq!(out.second, "hi");
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_enum_with_data_round_trip() {
    let pkg = dyn_pkg();
    let out: EnumOut = dyn_invoke(
        &pkg,
        "enum",
        &EnumIn {
            status: Status::Active { level: 9 },
        },
    );
    assert_eq!(out.label, "active:9");
    let out: EnumOut = dyn_invoke(
        &pkg,
        "enum",
        &EnumIn {
            status: Status::Idle,
        },
    );
    assert_eq!(out.label, "idle");
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_option_round_trip() {
    let pkg = dyn_pkg();
    let out: OptOut = dyn_invoke(
        &pkg,
        "opt",
        &OptIn {
            maybe: Some(5),
            name: None,
        },
    );
    assert!(out.has_value);
    let out: OptOut = dyn_invoke(
        &pkg,
        "opt",
        &OptIn {
            maybe: None,
            name: None,
        },
    );
    assert!(!out.has_value);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_nested_struct_round_trip() {
    let pkg = dyn_pkg();
    let out: NestedOut = dyn_invoke(
        &pkg,
        "nested",
        &NestedIn {
            inner: Inner { x: 1, y: 2.0 },
            list: vec![Inner { x: 10, y: 0.0 }, Inner { x: 100, y: 0.0 }],
        },
    );
    assert_eq!(out.sum_x, 111);
    assert_eq!(out.count, 3);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_unicode_and_emoji() {
    let pkg = dyn_pkg();
    let out: common::GreetOutput = dyn_invoke(
        &pkg,
        "greet",
        &common::GreetInput {
            name: "세계🌍".into(),
        },
    );
    assert_eq!(out.message, "hello 세계🌍");
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_empty_collections() {
    let pkg = dyn_pkg();
    let out: MapOut = dyn_invoke(
        &pkg,
        "map",
        &MapIn {
            scores: BTreeMap::new(),
        },
    );
    assert_eq!(out.count, 0);
    let out: NestedOut = dyn_invoke(
        &pkg,
        "nested",
        &NestedIn {
            inner: Inner { x: 5, y: 0.0 },
            list: vec![],
        },
    );
    assert_eq!(out.count, 1);
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_large_payload() {
    let pkg = dyn_pkg();
    let out: common::PayloadOutput = dyn_invoke(
        &pkg,
        "processPayload",
        &common::PayloadInput {
            items: common::make_items(1000),
        },
    );
    assert_eq!(out.count, 1000);
}

// ════════════════════════════════════════════════════════════
// 4. 동적 + 정적 단일 패키지 공존
// ════════════════════════════════════════════════════════════

#[test]
#[cfg(debug_assertions)]
fn static_and_dynamic_coexist_in_one_package() {
    // 정적 add(빌더, postcard) + 동적 echo(register, Tier 3) 가 한 패키지에 공존.
    let pkg = Package::builder("wire.mixed")
        .command("add", common::add)
        .build();
    pkg.register("echo", common::echo).unwrap();

    // 정적 경로(postcard)
    let out: common::AddOutput = static_invoke(&pkg, "add", &common::AddInput { a: 1, b: 41 });
    assert_eq!(out.value, 42);
    // 동적 경로(Tier 3 JSON)
    let out: common::EchoOutput = dyn_invoke(&pkg, "echo", &common::EchoInput { v: 99 });
    assert_eq!(out.v, 99);
}

// ════════════════════════════════════════════════════════════
// 5. 에러 경로
// ════════════════════════════════════════════════════════════

#[test]
fn truncated_payload_errors() {
    let pkg = Package::builder("wire.err.trunc")
        .command("add", common::add)
        .build();
    // 0바이트
    assert!(pkg.invoke_rkyv_v2(&[]).is_err());
    // 1바이트 (command_id 도 불충분)
    assert!(pkg.invoke_rkyv_v2(&[1]).is_err());
}

#[test]
fn unknown_command_id_errors() {
    let pkg = Package::builder("wire.err.unknown")
        .command("add", common::add)
        .build();
    // 존재하지 않는 command_id (999)
    let req = common::postcard_request(999, &common::AddInput { a: 1, b: 2 });
    let err = pkg.invoke_rkyv_v2(&req).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_malformed_json_errors() {
    let pkg = dyn_pkg();
    let id = common::command_id_of(&pkg, "echo");
    // malformed JSON
    let req = common::tier3_request(id, "{not valid json");
    let err = pkg.invoke_rkyv_v2(&req).unwrap_err();
    // tier3 JSON parse 실패 → invalid_args 계열
    assert!(
        err.code().contains("invalid") || err.to_string().to_lowercase().contains("json"),
        "unexpected error: {}",
        err
    );
}

#[test]
#[cfg(debug_assertions)]
fn dynamic_tier3_unknown_command_id_errors() {
    let pkg = dyn_pkg();
    // 어떤 commandId 도 존재하지 않음
    let req = common::tier3_request(9999, r#"{"v":1}"#);
    let err = pkg.invoke_rkyv_v2(&req).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}

#[test]
#[cfg(debug_assertions)]
fn unregister_then_invoke_errors() {
    let pkg = dyn_pkg();
    pkg.unregister("echo").unwrap();
    let id_after = common::command_id_of(&pkg, "add"); // echo 는 이제 없음
    let _ = id_after;
    // echo 호출 → not_found (JSON 엔진 경로도 동일)
    let req = common::tier3_request(1, r#"{"v":1}"#);
    let err = pkg.invoke_rkyv_v2(&req).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}

#[test]
#[cfg(debug_assertions)]
fn replace_missing_errors() {
    let pkg = dyn_pkg();
    let err = pkg.replace("nope", common::echo).unwrap_err();
    assert_eq!(err.code(), "command.not_found");
}

// 참고: id_exhaustion 경로는 lib.rs 인라인 테스트(register_errors_when_id_space_exhausted)가
// 이미 커버한다. 통합 테스트에선 private 필드(next_command_id) 조작이 불가하므로 여기서는 생략.

#[test]
#[cfg(debug_assertions)]
fn frozen_blocks_register_unregister_replace() {
    let pkg = dyn_pkg();
    pkg.freeze();
    assert_eq!(
        pkg.register("new", common::echo).unwrap_err().code(),
        "registry.frozen"
    );
    assert_eq!(
        pkg.unregister("echo").unwrap_err().code(),
        "registry.frozen"
    );
    assert_eq!(
        pkg.replace("echo", common::echo).unwrap_err().code(),
        "registry.frozen"
    );
    // 동결 상태에서도 기존 명령 invoke 는 정상
    let out: common::EchoOutput = dyn_invoke(&pkg, "echo", &common::EchoInput { v: 1 });
    assert_eq!(out.v, 1);
}

// ════════════════════════════════════════════════════════════
// 6. live_schema + error 응답 wire 포맷
// ════════════════════════════════════════════════════════════

#[test]
#[cfg(debug_assertions)]
fn live_schema_lists_all_dynamic_commands() {
    let pkg = dyn_pkg();
    let s = pkg.live_schema();
    let names: Vec<&str> = s["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    for expected in [
        "echo", "add", "greet", "map", "tuple", "enum", "opt", "nested",
    ] {
        assert!(
            names.contains(&expected),
            "live_schema missing '{expected}'"
        );
    }
    // commandId 단조 증가 + 서로 다름
    let ids: Vec<u64> = s["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["commandId"].as_u64().unwrap())
        .collect();
    let uniq: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(uniq.len(), ids.len(), "commandIds must be unique");
}

#[test]
fn encode_rkyv_v2_error_wire_format() {
    // `[ok: u8 @0=0][pad to @8][err_len: u16 LE @8][err utf8 @10]`
    let msg = "boom 💥";
    let buf = rustra::encode_rkyv_v2_error(msg);
    assert_eq!(buf[0], 0, "ok flag must be 0 for error");
    let len = u16::from_le_bytes(buf[8..10].try_into().unwrap()) as usize;
    let err = std::str::from_utf8(&buf[10..10 + len]).unwrap();
    assert_eq!(err, msg);
    assert_eq!(buf.len(), 10 + len);
}
