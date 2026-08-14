//! Task 3.5 (F7) — 필드 순서(postcard 선언 순서) 드리프트 감지.
//!
//! postcard 는 필드를 *선언 순서*대로 직렬화한다 (이름/알파벳 순이 아님).
//! 따라서 Rust struct 의 필드 순서를 재배치하거나 TS codegen 이 알파벳순으로
//! 정렬하면 wire 바이트가 **조용히** 바뀌며 타입 에러도 나지 않는다 —
//! Rust↔TS 가 눈에 띄지 않게 desync 되는 치명적 회귀(F7).
//!
//! 이 테스트는 비-알파벳순 struct(`ok, frozen, message` — 알파벳순이면
//! `frozen, message, ok`) 의 응답 본체를 바이트 단위로 고정한다. 같은 hex 가
//! TS 측(`field-order-drift.test.ts`) 에서 `rustraRegistryDemoCodec.decode` 의
//! 입력으로 쓰인다 — 양쪽 순서 합의가 바이트로 증명된다.

#![allow(clippy::float_cmp)]

use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[path = "../benches/common.rs"]
mod common;

/// 선언 순서 = `ok, frozen, message` (알파벳순이 아님: f < m < o).
/// `examples/calculator` 의 `RegistryDemoOutput` 와 동일한 모양/순서.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DriftOutput {
    ok: bool,
    frozen: bool,
    message: String,
}

/// 동일 필드를 *알파벳순* 으로 재배치한 variant — codegen/리팩터 드리프트 시뮬레이션.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DriftOutputAlpha {
    frozen: bool,
    message: String,
    ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct DriftInput;

fn drift_cmd(_input: DriftInput) -> rustra::Result<DriftOutput> {
    Ok(DriftOutput {
        ok: true,
        frozen: true,
        message: "drift".to_string(),
    })
}

/// 선언순 postcard 본체(ok, frozen, message):
///   `ok=0x01 | frozen=0x01 | len=0x05 | "drift"=64 72 69 66 74`
///
/// 응답 프레임은 `[ok_frame=0x01 @0][7B 0 @1..7][본체 @8]` 이므로
/// 본체는 `resp[8..]`. 이 8바이트는 TS 측 pinned hex 와 동일해야 한다.
const PINNED_BODY: &[u8] = &[0x01, 0x01, 0x05, b'd', b'r', b'i', b'f', b't'];

#[test]
fn rkyv_v2_response_body_pins_non_alphabetical_field_order() {
    let pkg = Package::builder("drift.test")
        .command("drift", drift_cmd)
        .build();
    let id = common::command_id_of(&pkg, "drift");
    let req = common::postcard_request(id, &DriftInput);
    let resp = pkg.invoke_rkyv_v2(&req).expect("drift command must invoke");

    // 본체(오프셋 8~) 가 선언순 pinned 바이트와 정확히 일치해야 한다.
    let body = &resp[8..];
    assert_eq!(
        body, PINNED_BODY,
        "postcard body must match pinned non-alphabetical field order (ok,frozen,message)"
    );
}

#[test]
fn correct_field_order_round_trips_pinned_body() {
    // 같은 바이트를 *올바른* 선언순 struct 로 디코드하면 의도한 값이 나온다.
    let out: DriftOutput = postcard::from_bytes(PINNED_BODY).expect("correct-order decode");
    assert!(out.ok);
    assert!(out.frozen);
    assert_eq!(out.message, "drift");
}

#[test]
fn alphabetically_reordered_decode_does_not_match_intended_values() {
    // 같은 바이트를 *알파벳순 재배치* struct 로 디코드하면 의도한 값이 나오지 않는다
    // (postcard 가 잘못된 위치의 바이트를 읽어 에러이거나 쓰레기값).
    // → 필드 순서가 wire 에 영향을 주며, 드리프트가 조용히 잘못된 데이터를 낳음을 증명.
    let out_intended = DriftOutput {
        ok: true,
        frozen: true,
        message: "drift".to_string(),
    };
    let alpha = postcard::from_bytes::<DriftOutputAlpha>(PINNED_BODY);
    let matches_intended = match &alpha {
        Ok(a) => {
            a.ok == out_intended.ok
                && a.frozen == out_intended.frozen
                && a.message == out_intended.message
        }
        Err(_) => false,
    };
    assert!(
        !matches_intended,
        "alphabetically-reordered decode must NOT reproduce intended values \
         (got {alpha:?}) — field order drives the wire, drift silently corrupts"
    );
}

/// ok 와 frozen 이 서로 다른 값(true/false)일 때 본체가 그 순서를 보존하는지
/// 추가로 고정 — ok/frozen 이 뒤바뀌는 드리프트(ok↔frozen swap)를 잡는다.
#[test]
fn distinct_ok_frozen_preserves_order_no_swap() {
    let distinct = DriftOutput {
        ok: true,
        frozen: false,
        message: "x".to_string(),
    };
    let body = postcard::to_allocvec(&distinct).expect("encode distinct");
    // 선언순: ok=0x01, frozen=0x00, len=0x01, 'x'
    assert_eq!(body, &[0x01, 0x00, 0x01, b'x']);
    let back: DriftOutput = postcard::from_bytes(&body).expect("decode distinct");
    assert_eq!(
        (back.ok, back.frozen),
        (true, false),
        "ok/frozen must not swap"
    );
}
