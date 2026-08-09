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
