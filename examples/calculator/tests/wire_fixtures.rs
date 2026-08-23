//! Phase 2 — 교차 와이어(cross-wire) fixture snapshot (Rust 측, Task 2.1 + 2.4).
//!
//! calculator 패키지의 대표 명령(addNumbers/greet/divide)에 대해 **실제**
//! `invoke_rkyv_v2` 와이어를 hex 로 고정한다. 이 hex 는
//! `packages/types/src/cross-wire.test.ts` 의 TS 교차 테스트가 generated
//! codec 으로 decode/encode 하는 것과 짝을 이뤄 Rust↔TS 바이너리 호환을 증명한다.
//!
//! - request  = `[cmd_id: u16 LE][postcard(Input)]`  ← TS codec.encode 와 동일
//! - response = `[ok:1][7B reserved][postcard(Output) @8]` (성공)
//!   `[ok:0][…][err_len: u16 LE @8][postcard{code,message} @10]` (에러)
//!
//! encode 알고리즘이 바뀌면 snapshot 단언이 실패 → fixture 를 의도적으로
//! 갱신해야 한다(스키마/코덱 드리프트 감지).
//!
//! **주의**: 이 hex 들은 TS 측 `cross-wire.test.ts` 와 반드시 일치해야 한다.
//! 한쪽만 바뀌면 교차 테스트가 실패한다.

use rustra_calculator_example::{
    AddNumbersInput, DivideInput, GaugeInput, GreetInput, ScoreTotalInput, SizeOfInput, SpanInput,
    calculator_package,
};

fn request_for<I: serde::Serialize>(cmd_id: u16, input: &I) -> Vec<u8> {
    let mut buf = cmd_id.to_le_bytes().to_vec();
    buf.extend_from_slice(&postcard::to_allocvec(input).expect("postcard encodes input"));
    buf
}

fn hexlify(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// invoke_rkyv_v2 의 Err 를 error frame 으로 변환한다 — 실제 FFI 경계
/// (`rustra_calculator_invoke_rkyv_v2`) 와 동일하게. TS codec.decode 가 보는
/// 진짜 와이어(성공 프레임 / 에러 프레임)를 낸다.
fn invoke_with_frame(pkg: &rustra::Package, req: &[u8]) -> Vec<u8> {
    match pkg.invoke_rkyv_v2(req) {
        Ok(bytes) => bytes,
        Err(error) => rustra::encode_rkyv_v2_error(&error),
    }
}

/// 교차 테스트용 canonical hex (TS 와 공유). hex 소문자, no separator.
const ADDNUMBERS_REQUEST: &str = "01000406";
const ADDNUMBERS_RESPONSE: &str = "01000000000000000a";
const GREET_REQUEST: &str = "0500044c796e78";
const GREET_RESPONSE: &str = "01000000000000000c48656c6c6f2c204c796e7821";
const DIVIDE_REQUEST: &str = "0a000200";
const DIVIDE_RESPONSE: &str = "00000000000000002a00136d6174682e6469766964655f62795f7a65726f1563616e6e6f7420646976696465206279207a65726f";

#[test]
fn addnumbers_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(1, &AddNumbersInput { a: 2, b: 3 });
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), ADDNUMBERS_REQUEST);
    assert_eq!(hexlify(&resp), ADDNUMBERS_RESPONSE);
}

#[test]
fn greet_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(
        5,
        &GreetInput {
            name: "Lynx".to_string(),
        },
    );
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), GREET_REQUEST);
    assert_eq!(hexlify(&resp), GREET_RESPONSE);
}

#[test]
fn divide_error_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(10, &DivideInput { a: 1, b: 0 });
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), DIVIDE_REQUEST);
    assert_eq!(hexlify(&resp), DIVIDE_RESPONSE);
    // 에러 프레임 구조 재확인: ok=0 @0, err_len u16 LE @8, 본문 @10.
    let r = &resp;
    assert_eq!(r[0], 0, "error frame must have ok=0");
    let err_len = u16::from_le_bytes([r[8], r[9]]);
    assert_eq!(err_len as usize + 10, r.len(), "err_len must span the body");
}

// ── 2026-08-22 타입 확장: bytes/map/tuple/uvar 와이어 고정 ──────
// probe 실측 계약: u32/u64 plain varint, map count+(k,v)*, tuple 무접두,
// Vec<u8> len+raw. TS cross-wire.test.ts 신규 블록과 짝이다.

const SIZEOF_REQUEST: &str = "0e0004010203fa";
const SIZEOF_RESPONSE: &str = "0100000000000000800204";
// HashMap 은 postcard 직렬화 순서가 비결정적(해시 시드) — 요청 hex 는
// 고정하지 않고(정렬된 a,b 순서면 "0f0002016114016240"), 응답만 고정한다.
// TS 인코더는 키를 정렬해 결정론적으로 인코딩하고 Rust 디코더는 순서독립
// 이므로 round-trip 계약은 성립한다.
const SCORETOTAL_RESPONSE: &str = "01000000000000000254";
const SPAN_REQUEST: &str = "100002686909";
const SPAN_RESPONSE: &str = "010000000000000002686909";
const GAUGE_REQUEST: &str = "1100ac02f0a204";
const GAUGE_RESPONSE: &str = "01000000000000009ca504";

#[test]
fn size_of_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(
        14,
        &SizeOfInput {
            data: vec![1, 2, 3, 250],
        },
    );
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), SIZEOF_REQUEST);
    assert_eq!(hexlify(&resp), SIZEOF_RESPONSE);
}

#[test]
fn score_total_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(
        15,
        &ScoreTotalInput {
            scores: std::collections::HashMap::from([("a".into(), 10i64), ("b".into(), 32i64)]),
        },
    );
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&resp), SCORETOTAL_RESPONSE);
    // 요청 구조 검증: [cmd 2B][count=2][2 엔트리] — count 바이트(@2) 고정.
    assert_eq!(req[0..3].to_vec(), vec![0x0f, 0x00, 0x02]);
    assert_eq!(req.len(), 9, "count(1) + 2 * (1+1 key + zigzag val)");
}

#[test]
fn span_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(
        16,
        &SpanInput {
            pair: ("hi".into(), -5),
        },
    );
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), SPAN_REQUEST);
    assert_eq!(hexlify(&resp), SPAN_RESPONSE);
}

#[test]
fn gauge_wire_is_stable() {
    let pkg = calculator_package();
    let req = request_for(
        17,
        &GaugeInput {
            limit: 300,
            offset: 70000,
        },
    );
    let resp = invoke_with_frame(&pkg, &req);
    assert_eq!(hexlify(&req), GAUGE_REQUEST);
    assert_eq!(hexlify(&resp), GAUGE_RESPONSE);
}
