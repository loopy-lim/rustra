//! proptest 속성 테스트 — 정적(postcard) + 동적(Tier 3) 경로의 round-trip 보존.
//!
//! 무작위 페이로드로 wire 직렬화/역직렬화가 값을 보존하는지 검증한다.
//! `register`(동적)는 debug 빌드에서만 동작.

#![allow(clippy::float_cmp)]

use proptest::prelude::*;
use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[path = "../benches/common.rs"]
mod common;

fn ascii_string() -> impl Strategy<Value = String> {
    prop::collection::vec(0u8..128, 0..32).prop_map(|b| String::from_utf8(b).unwrap())
}

/// 임의 Unicode (다중바이트 포함 — CJK/emoji/조합 마크). 모든 `char` 는 유효한
/// 스칼라 값이므로 수집 결과는 항상 정규화된 UTF-8 이다.
fn unicode_string() -> impl Strategy<Value = String> {
    prop::collection::vec(any::<char>(), 0..32).prop_map(|cs| cs.into_iter().collect())
}

// Tier 1 정적 postcard: 임의 i64 쌍 → add → a+b 보존.
// add 핸들러가 포화 없는 `+` 를 쓰므로 overflow 회피를 위해 ±1e9 로 제한.
proptest! {
    #[test]
    fn static_postcard_add_preserves(a in -1_000_000_000i64..1_000_000_000, b in -1_000_000_000i64..1_000_000_000) {
        let pkg = Package::builder("fuzz.add")
            .command("add", common::add)
            .build();
        let id = common::command_id_of(&pkg, "add");
        let req = common::postcard_request(id, &common::AddInput { a, b });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::AddOutput = common::decode_postcard_response(&resp);
        prop_assert_eq!(out.value, a + b);
    }
}

// Tier 2 정적 postcard: 임의 ASCII String → greet → "hello " + name 보존
proptest! {
    #[test]
    fn static_postcard_greet_preserves(name in ascii_string()) {
        let pkg = Package::builder("fuzz.greet")
            .command("greet", common::greet)
            .build();
        let id = common::command_id_of(&pkg, "greet");
        let req = common::postcard_request(id, &common::GreetInput { name: name.clone() });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::GreetOutput = common::decode_postcard_response(&resp);
        prop_assert_eq!(out.message, format!("hello {name}"));
    }
}

// Tier 2 정적 postcard: 임의 Vec<i64> → sumList → sum/count 보존
proptest! {
    #[test]
    fn static_postcard_sumlist_preserves(nums in prop::collection::vec(-1_000_000i64..1_000_000, 0..200)) {
        let pkg = Package::builder("fuzz.sum")
            .command("sumList", common::sum_list)
            .build();
        let id = common::command_id_of(&pkg, "sumList");
        let req = common::postcard_request(id, &common::SumListInput { numbers: nums.clone() });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::SumListOutput = common::decode_postcard_response(&resp);
        let expected_sum: i64 = nums.iter().sum();
        prop_assert_eq!(out.sum, expected_sum);
        prop_assert_eq!(out.count, nums.len() as i64);
    }
}

// Task 3.1a — i64 전체 범위 (postcard). addNumbers 는 a+b 로 overflow 되므로
// echo (값 그대로 반환) 로 2^63 경계까지 overflow 없이 직렬화 보존을 검증한다.
// postcard varint zigzag 는 i64 전체를 손실 없이 표현 → JS Number(2^53 초과 손실)
// 경로가 아닌 postcard 경로임을 2^53±1·2^32±1·MIN·MAX 에서 명시적으로 고정한다.
proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]
    #[test]
    fn static_postcard_echo_preserves_full_i64_range(v: i64) {
        let pkg = Package::builder("fuzz.echo").command("echo", common::echo).build();
        let id = common::command_id_of(&pkg, "echo");
        let req = common::postcard_request(id, &common::EchoInput { v });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::EchoOutput = common::decode_postcard_response(&resp);
        prop_assert_eq!(out.v, v);
    }
}

#[test]
fn static_postcard_echo_preserves_i64_precision_boundaries() {
    // JS Number 가 정밀도를 잃는 임계값(2^53)과 32비트 경계(2^32)를 포함해
    // postcard wire 가 i64 전체를 손실 없이 round-trip 함을 결정론적으로 고정.
    let pkg = Package::builder("fuzz.echo.boundary")
        .command("echo", common::echo)
        .build();
    let id = common::command_id_of(&pkg, "echo");
    let boundaries = [
        0i64,
        1,
        -1,
        i64::MIN,
        i64::MAX,
        // 2^53 ± 1: JS Number 정밀도 경계
        (1i64 << 53) - 1,
        1i64 << 53,
        (1i64 << 53) + 1,
        -((1i64 << 53) + 1),
        // 2^32 ± 1: 32비트 경계
        (1i64 << 32) - 1,
        1i64 << 32,
        (1i64 << 32) + 1,
    ];
    for v in boundaries {
        let req = common::postcard_request(id, &common::EchoInput { v });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::EchoOutput = common::decode_postcard_response(&resp);
        assert_eq!(out.v, v, "i64 boundary {v} must round-trip losslessly");
    }
}

// Task 3.1b — Unicode (다중바이트 UTF-8). ASCII 만으로는 CJK(3B)/emoji(4B) 의
// 바이트 길이 왜곡을 잡을 수 없다. greet 가 name 을 그대로 보존하므로 round-trip 검증.
proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    #[test]
    fn static_postcard_greet_preserves_unicode(name in unicode_string()) {
        let pkg = Package::builder("fuzz.greet.uni")
            .command("greet", common::greet)
            .build();
        let id = common::command_id_of(&pkg, "greet");
        let req = common::postcard_request(id, &common::GreetInput { name: name.clone() });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::GreetOutput = common::decode_postcard_response(&resp);
        // name 이 응답 안에 바이트-동일하게 보존되는지(접두/접미 외 부분) 확인.
        prop_assert_eq!(&out.message, &format!("hello {name}"));
        prop_assert!(out.message.ends_with(&name), "unicode name must be preserved verbatim");
    }
}

#[test]
fn static_postcard_greet_preserves_known_tricky_unicode() {
    // 결정론적: surrogate-pair emoji, ZWJ 시퀀스, 조합 마크, CJK, 제어문자 혼합.
    let pkg = Package::builder("fuzz.greet.tricky")
        .command("greet", common::greet)
        .build();
    let id = common::command_id_of(&pkg, "greet");
    let cases = [
        "가나다라",           // 3-byte Hangul
        "🦀🦀",               // 4-byte emoji
        "👨‍👩‍👧",                 // ZWJ family sequence
        "e\u{0301}",          // combining acute → é (2 code points)
        "\u{0}",              // NUL byte inside String
        "混合 Mixed 混合 🔀", // multi-script + symbol
    ];
    for name in cases {
        let req = common::postcard_request(
            id,
            &common::GreetInput {
                name: name.to_string(),
            },
        );
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: common::GreetOutput = common::decode_postcard_response(&resp);
        assert_eq!(
            out.message,
            format!("hello {name}"),
            "tricky unicode must round-trip"
        );
    }
}

// Task 3.1c — 중첩 struct round-trip (postcard). postcard 는 필드 *순서* 기반
// 직렬화이므로 중첩 구조체의 순서/타입이 정확히 보존되는지 검증한다.
// (필드 순서 드리프트 감지는 Task 3.5 에서 바이트 단위로 고정.)
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NestedInner {
    active: bool,
    name: String,
    value: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NestedEchoInput {
    item: NestedInner,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct NestedEchoOutput {
    item: NestedInner,
}
fn echo_nested(input: NestedEchoInput) -> rustra::Result<NestedEchoOutput> {
    Ok(NestedEchoOutput { item: input.item })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    #[test]
    fn static_postcard_nested_struct_round_trip(
        active: bool,
        name in unicode_string(),
        value: i64,
    ) {
        let pkg = Package::builder("fuzz.nested")
            .command("echoNested", echo_nested)
            .build();
        let id = common::command_id_of(&pkg, "echoNested");
        let inner = NestedInner { active, name: name.clone(), value };
        let req = common::postcard_request(id, &NestedEchoInput { item: inner.clone() });
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let out: NestedEchoOutput = common::decode_postcard_response(&resp);
        prop_assert_eq!(out.item, inner);
    }
}

// 동적 Tier 3 전용 fuzz 타입: i64 + String + Vec<i64> + bool + f64 혼합
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FuzzIn {
    n: i64,
    s: String,
    list: Vec<i64>,
    flag: bool,
    score: f64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FuzzOut {
    n: i64,
    s: String,
    list: Vec<i64>,
    flag: bool,
    score: f64,
}
fn fuzz_echo(input: FuzzIn) -> rustra::Result<FuzzOut> {
    Ok(FuzzOut {
        n: input.n,
        s: input.s,
        list: input.list,
        flag: input.flag,
        score: input.score,
    })
}

// 동적 Tier 3: 임의 혼합 값 → JSON wire round-trip 보존
proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    #[test]
    #[cfg(debug_assertions)]
    fn dynamic_tier3_mixed_round_trip(
        n: i64,
        s in ascii_string(),
        list in prop::collection::vec(-1_000_000i64..1_000_000, 0..100),
        flag: bool,
        score in -1e6f64..1e6,
    ) {
        let pkg = Package::builder("fuzz.dyn").build();
        pkg.register("echo", fuzz_echo).unwrap();
        let id = common::command_id_of(&pkg, "echo");
        let input = FuzzIn {
            n,
            s: s.clone(),
            list: list.clone(),
            flag,
            score,
        };
        let json = serde_json::to_string(&input).unwrap();
        let req = common::tier3_request(id, &json);
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let val = common::decode_tier3_response(&resp);
        let out: FuzzOut = serde_json::from_value(val).unwrap();
        prop_assert_eq!(out.n, n);
        prop_assert_eq!(out.s, s);
        prop_assert_eq!(out.list, list);
        prop_assert_eq!(out.flag, flag);
        // f64 는 JSON 직렬화 백엔드에 따라 비트 단위 보존이 보장되지 않을 수 있으므로
        // 상대 허용오차로 비교한다.
        let abs_diff = (out.score - score).abs();
        let tol = 1e-9 * score.abs().max(1.0);
        prop_assert!(
            abs_diff <= tol,
            "f64 drift too large: out={} in={} diff={abs_diff}",
            out.score,
            score
        );
    }
}

// 동적 Tier 3: 큰 Vec<i64> (최대 2000) → sum 보존
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    #[cfg(debug_assertions)]
    fn dynamic_tier3_large_vec_sum(
        nums in prop::collection::vec(-10_000i64..10_000, 0..2000)
    ) {
        let pkg = Package::builder("fuzz.dynlarge").build();
        pkg.register("sumList", common::sum_list).unwrap();
        let id = common::command_id_of(&pkg, "sumList");
        let input = common::SumListInput { numbers: nums.clone() };
        let json = serde_json::to_string(&input).unwrap();
        let req = common::tier3_request(id, &json);
        let resp = pkg.invoke_rkyv_v2(&req).unwrap();
        let val = common::decode_tier3_response(&resp);
        let out: common::SumListOutput = serde_json::from_value(val).unwrap();
        let expected: i64 = nums.iter().sum();
        prop_assert_eq!(out.sum, expected);
        prop_assert_eq!(out.count, nums.len() as i64);
    }
}
