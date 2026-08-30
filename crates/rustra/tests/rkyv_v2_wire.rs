//! rkyv V2 wire path 종합 테스트 — dynamic import(Tier 3) + 정적 binary 경로.
//!
//! 도달 가능한 두 wire 를 다양한 타입으로 검증:
//! - 정적 binary: `[cmd_id u16][postcard 또는 complex(I)]` → `[ok u8][body@8]`
//! - 동적(Tier 3 JSON):        `[cmd_id u16][json]`         → `[ok u8][pad3][json_len u32@4][json@8]`
//!
//! `register`(동적 명령)는 debug 빌드에서만 동작(release=frozen). 정적 테스트는 양쪽 모두.

#![allow(clippy::float_cmp)]
#![cfg_attr(not(debug_assertions), allow(dead_code, unused_imports))]

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

// 정적 binary 경로의 Option 왕복 — JS 코드젠 option_* 코덱과 동일 와이어.
// (과거 결함: JS 코덱이 Option 필드를 무음 삭제 — 여기가 Rust 측 계약 고정점)
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StaticOptIn {
    id: String,
    name: Option<String>,
    value: Option<i32>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct StaticOptOut {
    item: Option<StaticItem>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
struct StaticItem {
    id: String,
    name: String,
    value: i32,
}
fn static_opt_cmd(input: StaticOptIn) -> rustra::Result<StaticOptOut> {
    let item = match (input.name, input.value) {
        (Some(name), Some(value)) => Some(StaticItem {
            id: input.id,
            name,
            value,
        }),
        _ => None,
    };
    Ok(StaticOptOut { item })
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
    len: u32,
    checksum: u32,
}
fn bytes_cmd(input: BytesIn) -> rustra::Result<BytesOut> {
    Ok(BytesOut {
        len: input.data.len() as u32,
        checksum: input.data.iter().map(|&b| b as u32).sum(),
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
    bool_count: u32,
    float_sum: f64,
    int32_sum: i32,
}
fn mixed_vec_cmd(input: MixedVecIn) -> rustra::Result<MixedVecOut> {
    Ok(MixedVecOut {
        bool_count: input.bools.iter().filter(|b| **b).count() as u32,
        float_sum: input.floats.iter().sum(),
        int32_sum: input.ints32.iter().sum(),
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

/// 정적 binary 경로 호출 헬퍼.
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

/// 동적 명령 호출 헬퍼. (T2-1 이후) 동적 명령은 정적 명령과 동일한 라우트 선택을
/// 받는다 — postcard 지원 형태면 binary(또는 complex) 핸들러, 양쪽 미지원 형태만
/// Tier 3 JSON. 이 헬퍼는 postcard 요청으로 왕복한다(섹션 3의 동적 명령들은
/// 모두 postcard 지원 형태). Tier 3 전용 왕복은 하단 `dynamic_tier3_*` 에러
/// 경로 테스트와 lib의 `dynamic_unsupported_schema_stays_tier3` 가 담당한다.
#[cfg(debug_assertions)]
fn dyn_invoke<I: Serialize, O: serde::de::DeserializeOwned>(
    pkg: &Package,
    name: &str,
    input: &I,
) -> O {
    let id = common::command_id_of(pkg, name);
    let req = common::postcard_request(id, input);
    let resp = pkg.invoke_rkyv_v2(&req).expect("dyn invoke ok");
    common::decode_postcard_response::<O>(&resp)
}

// ════════════════════════════════════════════════════════════
// 1. 정적 Tier 1 (postcard 또는 i64 complex fast-path)
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

// 정적 binary Option 왕복 — Some/None 전 조합 + Option<Struct> 응답.
#[test]
fn static_postcard_option_round_trip() {
    let pkg = Package::builder("wire.static.opt")
        .command("staticOpt", static_opt_cmd)
        .build();
    // Some/Some → Some(item)
    let out: StaticOptOut = static_invoke(
        &pkg,
        "staticOpt",
        &StaticOptIn {
            id: "x1".into(),
            name: Some("W".into()),
            value: Some(42),
        },
    );
    assert_eq!(
        out.item,
        Some(StaticItem {
            id: "x1".into(),
            name: "W".into(),
            value: 42
        })
    );
    // None value → None item
    let out: StaticOptOut = static_invoke(
        &pkg,
        "staticOpt",
        &StaticOptIn {
            id: "x2".into(),
            name: Some("W".into()),
            value: None,
        },
    );
    assert_eq!(out.item, None);
    // 둘 다 None → None item
    let out: StaticOptOut = static_invoke(
        &pkg,
        "staticOpt",
        &StaticOptIn {
            id: "x3".into(),
            name: None,
            value: None,
        },
    );
    assert_eq!(out.item, None);
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
    // 정적 add(빌더, complex for i64) + 동적 echo(register, Tier 3) 가 한 패키지에 공존.
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
fn dynamic_promoted_command_no_longer_parses_tier3_json() {
    // (T2-1) postcard 지원 형태 명령(echo)은 더 이상 Tier 3 를 서빙하지 않는다 —
    // malformed JSON 프레임은 JSON 파서가 아니라 postcard 디코더로 간다
    // (postcard 는 trailing bytes 를 무시하므로 첫 varint 가 유효하면 Ok).
    // Tier 3 JSON 파싱 오류 계약은 양쪽 미지원 형태(untagged any) 명령이 유지한다
    // — lib의 dynamic_unsupported_schema_stays_tier3 와 그 변형이 담당.
    let pkg = dyn_pkg();
    let id = common::command_id_of(&pkg, "echo");
    // "{not valid json" → postcard varint 0x7B = zigzag(-62) → Ok(EchoIn{v:-62}).
    // tier3 JSON 파서였다면 parse 실패 에러를 반환했을 것이다 — Ok 가 승격 증명.
    let req = common::tier3_request(id, "{not valid json");
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("postcard decode of garbage");
    let out: common::EchoOutput = common::decode_postcard_response(&resp);
    assert_eq!(out.v, -62);
    // 정상 postcard 프레임도 그대로 동작.
    let postcard_req = common::postcard_request(id, &common::EchoInput { v: 5 });
    let resp = pkg.invoke_rkyv_v2(&postcard_req).expect("postcard invoke");
    let out: common::EchoOutput = common::decode_postcard_response(&resp);
    assert_eq!(out.v, 5);
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
    // `[ok: u8 @0=0][pad to @8][err_len: u16 LE @8][postcard({code,message}) @10]`
    let error = rustra::RustraError::custom("math.divide_by_zero", "boom 💥");
    let buf = rustra::encode_rkyv_v2_error(&error);
    assert_eq!(buf[0], 0, "ok flag must be 0 for error");
    let len = u16::from_le_bytes(buf[8..10].try_into().unwrap()) as usize;
    assert_eq!(buf.len(), 10 + len);
    // postcard of ({ code: String, message: String }) = [varint code_len][code][varint msg_len][msg]
    #[derive(serde::Deserialize)]
    struct Wire {
        code: String,
        message: String,
    }
    let wire: Wire = postcard::from_bytes(&buf[10..10 + len]).unwrap();
    assert_eq!(wire.code, "math.divide_by_zero");
    assert_eq!(wire.message, "boom 💥");
}

// ── (계약 갱신) map 명령의 fast-path 승격 ──────────────────
//
// 2026-08-22 타입 확장으로 HashMap<String, 원시값> 필드는 JS/Rust 양쪽 postcard
// 코덱이 지원한다(count varint + (key,value)*; probe: {a:1,b:2} ->
// [2, 1,98,4, 1,97,2]). 과거 map 은 Tier 3(JSON-in-binary) 강제였다 — 이제
// postcard fast-path 로 승격됐고, 이 테스트가 그 와이어를 고정한다.
// 복합 data enum(oneOf)의 complex binary 라우팅은
// oneof_command_uses_complex_binary_wire 로 검증한다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct JsUnsupportedIn {
    scores: BTreeMap<String, i64>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct JsUnsupportedOut {
    total: i64,
}
fn js_unsupported_cmd(input: JsUnsupportedIn) -> rustra::Result<JsUnsupportedOut> {
    Ok(JsUnsupportedOut {
        total: input.scores.values().sum(),
    })
}

#[test]
fn map_command_uses_postcard_fast_path() {
    let pkg = Package::builder("wire.t3align.map")
        .command("mapTotal", js_unsupported_cmd)
        .build();

    // postcard fast-path 요청: [cmd_id u16 LE][postcard({scores: {a:10,b:32}})]
    let input = JsUnsupportedIn {
        scores: BTreeMap::from([("a".into(), 10), ("b".into(), 32)]),
    };
    let req = common::postcard_request(1, &input);
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("postcard invoke must succeed");

    // postcard 응답: [ok:1][pad 7B][postcard(total i64)] — @8 이 zigzag(42)=84 1바이트.
    assert_eq!(resp[0], 1, "ok");
    let out: JsUnsupportedOut = common::decode_postcard_response(&resp);
    assert_eq!(out.total, 42);
    assert_eq!(resp.len(), 9, "postcard frame: 8B header + 1B zigzag(42)");
}

// data enum(oneOf) — complex binary path. Variant order is derived from the
// deterministic schema key, so schemars declaration reordering is harmless.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct OneOfIn {
    status: Status,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct OneOfOut {
    status: Status,
}
fn oneof_cmd(input: OneOfIn) -> rustra::Result<OneOfOut> {
    Ok(OneOfOut {
        status: input.status,
    })
}

#[test]
fn oneof_command_uses_complex_binary_wire() {
    let pkg = Package::builder("wire.t3align.oneof")
        .command("oneofLabel", oneof_cmd)
        .build();
    // [command_id u16][variant index][active.level zigzag varint]
    let req = [1, 0, 0, 14];
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("complex invoke must succeed");
    assert_eq!(resp[0], 1, "ok");
    // Output is the same data enum: [variant index][active.level zigzag varint].
    assert_eq!(&resp[8..], &[0, 14]);
}

#[test]
fn supported_types_keep_postcard_fast_path() {
    // Option/Vec<String>/Vec<Struct>/enum 은 이제 JS 코덱 지원 — fast-path 유지.
    // (static_opt_cmd 는 Option 필드 — postcard 왕복이 유지되는지 재확인)
    let pkg = Package::builder("wire.t3align.keep")
        .command("staticOpt", static_opt_cmd)
        .build();
    let out: StaticOptOut = static_invoke(
        &pkg,
        "staticOpt",
        &StaticOptIn {
            id: "z".into(),
            name: Some("N".into()),
            value: Some(9),
        },
    );
    assert_eq!(
        out.item,
        Some(StaticItem {
            id: "z".into(),
            name: "N".into(),
            value: 9
        })
    );
}
